/**
 * Analytics Export API Route
 * Exports deployment data as CSV
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured,  createServerClient } from '@/lib/supabase';
import { parseAccessToken } from '@/lib/auth-utils';

export async function GET(request: NextRequest) {
  try {    // Self-hosted SQLite stub: return empty/default when Supabase not configured
    if (!isSupabaseConfigured()) {
      return NextResponse.json({ data: [], items: [], count: 0, message: 'Feature requires Supabase configuration' }, { status: 200 });
    }

    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Get date range from query params (default: last 30 days)
    // Clamp to reasonable range: 1-365 days
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get('days');
    const days = Math.min(Math.max(parseInt(daysParam || '30', 10) || 30, 1), 365);

    // Use UTC for consistent timezone handling with database timestamps
    const now = new Date();
    const startDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - days
    ));

    const supabase = createServerClient();

    // Define the shape of jobs returned from the query
    interface PackagingJobExport {
      id: string;
      winget_id: string;
      display_name: string;
      publisher: string | null;
      version: string;
      architecture: string | null;
      installer_type: string;
      status: string;
      error_message: string | null;
      intune_app_id: string | null;
      created_at: string;
      completed_at: string | null;
    }

    // Get all jobs in date range
    const { data: jobs, error: jobsError } = await supabase
      .from('packaging_jobs')
      .select(`
        id,
        winget_id,
        display_name,
        publisher,
        version,
        architecture,
        installer_type,
        status,
        error_message,
        intune_app_id,
        created_at,
        completed_at
      `)
      .eq('user_id', user.userId)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (jobsError) {
      return NextResponse.json(
        { error: 'Failed to fetch data for export' },
        { status: 500 }
      );
    }

    // Build CSV
    const headers = [
      'Job ID',
      'Winget ID',
      'Display Name',
      'Publisher',
      'Version',
      'Architecture',
      'Installer Type',
      'Status',
      'Intune App ID',
      'Error Message',
      'Created At',
      'Completed At',
    ];

    const allJobs = (jobs || []) as PackagingJobExport[];
    const rows = allJobs.map((job) => [
      job.id,
      job.winget_id,
      job.display_name,
      job.publisher || '',
      job.version,
      job.architecture || '',
      job.installer_type || '',
      job.status,
      job.intune_app_id || '',
      (job.error_message || '').replace(/"/g, '""'),
      job.created_at,
      job.completed_at || '',
    ]);

    // Escape CSV values
    const escapeCSV = (value: string): string => {
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value}"`;
      }
      return value;
    };

    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map((row: string[]) => row.map(escapeCSV).join(',')),
    ].join('\n');

    // Return CSV response
    const filename = `intuneget-deployments-${new Date().toISOString().split('T')[0]}.csv`;

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to export data' },
      { status: 500 }
    );
  }
}
