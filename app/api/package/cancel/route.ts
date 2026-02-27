/**
 * Cancel Package API Route
 * Cancels pending or in-process packaging jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { getDatabase } from '@/lib/db';
import { cancelWorkflowRun, isGitHubActionsConfigured } from '@/lib/github-actions';
import { parseAccessToken } from '@/lib/auth-utils';
import { handleAutoUpdateJobCompletion } from '@/lib/auto-update/cleanup';
import type { Database } from '@/types/database';

interface CancelRequestBody {
  jobId: string;
  dismiss?: boolean;
}

type PackagingJobRow = Database['public']['Tables']['packaging_jobs']['Row'];
type PackagingJobUpdate = Database['public']['Tables']['packaging_jobs']['Update'];

// Statuses that can be cancelled (active jobs)
const CANCELLABLE_STATUSES = ['queued', 'packaging', 'uploading'];
// Statuses that can be force-dismissed by the user
const DISMISSABLE_STATUSES = ['queued', 'packaging', 'uploading', 'completed', 'failed'];

export async function POST(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const userId = user.userId;
    const userEmail = user.userEmail;

    // Parse request body
    const body: CancelRequestBody = await request.json();
    const { jobId, dismiss } = body;

    if (!jobId) {
      return NextResponse.json(
        { error: 'jobId is required' },
        { status: 400 }
      );
    }

    // Fetch the job to verify ownership and check status
    const db = getDatabase();
    const typedJob = await db.jobs.getById(jobId) as PackagingJobRow | null;

    if (!typedJob) {
      // Fallback to Supabase if configured
      if (!isSupabaseConfigured()) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }
      const supabase = createServerClient();
      const { data: job, error: fetchError } = await supabase
        .from('packaging_jobs').select('*').eq('id', jobId).single();
      if (fetchError || !job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }
    }

    if (!typedJob) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Verify the user owns this job
    if (typedJob.user_id !== userId) {
      return NextResponse.json(
        { error: 'You do not have permission to cancel this job' },
        { status: 403 }
      );
    }

    // If dismiss flag is set and job is in a terminal state, delete the row
    const terminalStatuses = ['completed', 'failed', 'cancelled', 'duplicate_skipped', 'deployed'];
    if (dismiss && terminalStatuses.includes(typedJob.status)) {
      // Run auto-update cleanup before deleting (defense-in-depth for stuck jobs)
      if (typedJob.is_auto_update && isSupabaseConfigured()) {
        const dismissStatus = (typedJob.status === 'deployed' || typedJob.status === 'duplicate_skipped')
          ? typedJob.status as 'deployed' | 'duplicate_skipped'
          : 'cancelled';
        await handleAutoUpdateJobCompletion(jobId, dismissStatus).catch((err) => {
          console.error('[Cancel] Auto-update cleanup error on dismiss:', err);
        });
      }
      const db = getDatabase();
      await db.jobs.deleteById(jobId);
      return NextResponse.json({
        success: true,
        message: 'Job dismissed and removed',
        jobId,
        deleted: true,
      });
    }

    // Check if job is already cancelled or deployed (cannot be modified)
    if (typedJob.status === 'cancelled') {
      return NextResponse.json({
        success: true,
        message: 'Job is already cancelled',
        jobId,
        githubCancelled: null,
      });
    }

    if (typedJob.status === 'deployed') {
      return NextResponse.json(
        { error: 'Cannot cancel a deployed job. It is already in Intune.' },
        { status: 400 }
      );
    }

    // Check if job can be dismissed
    if (!DISMISSABLE_STATUSES.includes(typedJob.status)) {
      return NextResponse.json(
        { error: `Job cannot be cancelled. Current status: ${typedJob.status}` },
        { status: 400 }
      );
    }

    // Attempt to cancel GitHub workflow if run ID exists and job is still active
    let githubCancelResult = null;
    const isActiveJob = CANCELLABLE_STATUSES.includes(typedJob.status);
    if (isActiveJob && typedJob.github_run_id && isGitHubActionsConfigured()) {
      githubCancelResult = await cancelWorkflowRun(typedJob.github_run_id);
    }

    // Update job status to cancelled in database
    // We update regardless of GitHub result - the user wants this cancelled/dismissed
    let errorMessage = 'Job cancelled by user';
    if (!isActiveJob) {
      errorMessage = `Job dismissed by user (was ${typedJob.status})`;
    } else if (githubCancelResult && !githubCancelResult.success) {
      errorMessage = `Job cancelled by user. GitHub workflow: ${githubCancelResult.message}`;
    }

    // Use token email, or fall back to job's stored user_email
    const cancelledByEmail = userEmail || typedJob.user_email || 'unknown';

    // Update job status to cancelled using the database adapter (works for both SQLite and Supabase)
    const conditions = isActiveJob
      ? { status: typedJob.status }
      : undefined;

    const updated = await db.jobs.update(jobId, {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: cancelledByEmail,
      error_message: errorMessage,
    }, conditions);

    if (!updated) {
      return NextResponse.json(
        { error: 'Failed to update job status. The job may have already changed status.' },
        { status: 500 }
      );
    }

    // Clean up auto-update tracking (Supabase only)
    if (isSupabaseConfigured()) {
      handleAutoUpdateJobCompletion(jobId, 'cancelled', errorMessage).catch((err) => {
        console.error('[Cancel] Auto-update cleanup error:', err);
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Job cancelled successfully',
      jobId,
      githubCancelled: githubCancelResult?.success ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Cancel] Unhandled error:', err);
    return NextResponse.json(
      { error: 'Internal server error', detail: message },
      { status: 500 }
    );
  }
}
