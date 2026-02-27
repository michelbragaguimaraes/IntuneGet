/**
 * Updates Refresh API Route
 * POST - Run an on-demand update scan and refresh cached update results
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseVersion } from '@/lib/version-compare';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { getDb as getSqliteDb } from '@/lib/db/sqlite';
import { parseAccessToken } from '@/lib/auth-utils';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { GET as getLiveIntuneUpdates } from '@/app/api/intune/apps/updates/route';
import type { AppUpdateInfo } from '@/types/inventory';

interface RefreshRequestBody {
  tenant_id?: string;
}

interface LiveUpdatesResponse {
  updates: AppUpdateInfo[];
  updateCount: number;
  checkedApps?: Array<{
    app: string;
    wingetId: string | null;
    result: string;
  }>;
}

interface UpdateCheckRow {
  id: string;
  winget_id: string;
  intune_app_id: string;
}

function isCriticalUpdate(currentVersion: string, latestVersion: string): boolean {
  const current = parseVersion(currentVersion || '0.0.0');
  const latest = parseVersion(latestVersion || '0.0.0');
  return latest.major > current.major;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const user = await parseAccessToken(authHeader);
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as RefreshRequestBody;
    const requestedTenantId = body.tenant_id?.trim() || null;

    if (!authHeader) {
      return NextResponse.json(
        { error: 'Authentication header is required' },
        { status: 401 }
      );
    }

    let tenantId: string;
    let supabase: ReturnType<typeof createServerClient> | null = null;

    if (isSupabaseConfigured()) {
      supabase = createServerClient();

      const tenantResolution = await resolveTargetTenantId({
        supabase,
        userId: user.userId,
        tokenTenantId: user.tenantId,
        requestedTenantId,
      });

      if (tenantResolution.errorResponse) {
        return tenantResolution.errorResponse;
      }

      tenantId = tenantResolution.tenantId;
    } else {
      tenantId = requestedTenantId || user.tenantId;
    }

    // Reuse the live Intune matching route, then sync results into update_check_results.
    // The live route calls the Graph API list endpoint which returns largeIcon data inline.
    const forwardHeaders = new Headers({
      Authorization: authHeader,
    });
    if (requestedTenantId && requestedTenantId !== user.tenantId) {
      forwardHeaders.set('X-MSP-Tenant-Id', requestedTenantId);
    }

    const liveRequest = new NextRequest(
      `${request.nextUrl.origin}/api/intune/apps/updates`,
      { headers: forwardHeaders }
    );
    const liveResponse = await getLiveIntuneUpdates(liveRequest);

    if (!liveResponse.ok) {
      const errorBody = await liveResponse.json().catch(() => ({ error: 'Live update check failed' }));
      return NextResponse.json(errorBody, { status: liveResponse.status });
    }

    const liveData = (await liveResponse.json()) as LiveUpdatesResponse;
    const now = new Date().toISOString();
    const rows = liveData.updates
      .filter((update) => Boolean(update.wingetId))
      .filter((update) => update.currentVersion !== 'Unknown')
      .map((update) => ({
        user_id: user.userId,
        tenant_id: tenantId,
        winget_id: update.wingetId as string,
        intune_app_id: update.intuneApp.id,
        display_name: update.intuneApp.displayName,
        current_version: update.currentVersion,
        latest_version: update.latestVersion,
        is_critical: isCriticalUpdate(update.currentVersion, update.latestVersion),
        large_icon_type: update.intuneApp.largeIcon?.type || null,
        large_icon_value: update.intuneApp.largeIcon?.value || null,
        detected_at: now,
        updated_at: now,
      }));

    let removedCount = 0;

    if (supabase) {
      // Supabase path: upsert new rows then remove stale ones
      if (rows.length > 0) {
        const { error: upsertError } = await supabase
          .from('update_check_results')
          .upsert(rows, { onConflict: 'user_id,tenant_id,winget_id,intune_app_id' });

        if (upsertError) {
          return NextResponse.json(
            { error: `Failed to store updates: ${upsertError.message}` },
            { status: 500 }
          );
        }
      }

      const activeKeys = new Set(
        rows.map((row) => `${row.winget_id}:${row.intune_app_id}`)
      );

      const { data: existingRows, error: existingRowsError } = await supabase
        .from('update_check_results')
        .select('id, winget_id, intune_app_id')
        .eq('user_id', user.userId)
        .eq('tenant_id', tenantId);

      if (existingRowsError) {
        return NextResponse.json(
          { error: `Failed to load existing updates: ${existingRowsError.message}` },
          { status: 500 }
        );
      }

      const staleIds = (existingRows as UpdateCheckRow[] || [])
        .filter((row) => !activeKeys.has(`${row.winget_id}:${row.intune_app_id}`))
        .map((row) => row.id);

      if (staleIds.length > 0) {
        const { error: deleteError } = await supabase
          .from('update_check_results')
          .delete()
          .in('id', staleIds);

        if (deleteError) {
          return NextResponse.json(
            { error: `Failed to remove stale updates: ${deleteError.message}` },
            { status: 500 }
          );
        }
        removedCount = staleIds.length;
      }
    } else {
      // SQLite path: delete all existing for this user+tenant, then insert fresh
      const sqliteDatabase = getSqliteDb();
      const deleteResult = sqliteDatabase.prepare(
        'DELETE FROM update_check_results WHERE user_id = ? AND tenant_id = ?'
      ).run(user.userId, tenantId);
      removedCount = deleteResult.changes;

      const insertStmt = sqliteDatabase.prepare(`
        INSERT OR REPLACE INTO update_check_results
          (user_id, tenant_id, winget_id, intune_app_id, display_name, current_version,
           latest_version, is_critical, large_icon_type, large_icon_value, detected_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of rows) {
        insertStmt.run(
          row.user_id,
          row.tenant_id,
          row.winget_id,
          row.intune_app_id,
          row.display_name,
          row.current_version,
          row.latest_version,
          row.is_critical ? 1 : 0,
          row.large_icon_type,
          row.large_icon_value,
          row.detected_at,
          row.updated_at
        );
      }
    }

    return NextResponse.json({
      success: true,
      refreshedCount: rows.length,
      removedCount,
      updateCount: liveData.updateCount,
      matchingSummary: {
        totalChecked: liveData.checkedApps?.length || 0,
        noMatch: liveData.checkedApps?.filter((item) => item.result === 'No match found').length || 0,
        lowConfidenceSkipped: liveData.checkedApps?.filter((item) => item.result.includes('Low confidence')).length || 0,
        packageNotInCache: liveData.checkedApps?.filter((item) => item.result === 'Package not in cache').length || 0,
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
