import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { parseAccessToken } from '@/lib/auth-utils';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';

interface UploadHistoryRow {
  winget_id: string;
}

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // SQLite self-hosted fallback
    if (!isSupabaseConfigured()) {
      const Database = require('better-sqlite3');
      const db = new Database(process.env.DATABASE_PATH || './data/intuneget.db');

      const rows = db.prepare(`
        SELECT DISTINCT winget_id FROM upload_history WHERE user_id = ?
      `).all(user.userId) as Array<{ winget_id: string }>;

      const deployedWingetIds = rows.map((r) => r.winget_id).filter(Boolean);

      return NextResponse.json({
        deployedWingetIds,
        count: deployedWingetIds.length,
      });
    }

    const supabase = createServerClient();
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = await resolveTargetTenantId({
      supabase,
      userId: user.userId,
      tokenTenantId: user.tenantId,
      requestedTenantId: mspTenantId,
    });

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }

    const { data, error } = await supabase
      .from('upload_history')
      .select('winget_id')
      .eq('user_id', user.userId)
      .eq('intune_tenant_id', tenantResolution.tenantId);

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch deployed packages' },
        { status: 500 }
      );
    }

    const deployedWingetIds = Array.from(
      new Set(
        ((data || []) as UploadHistoryRow[])
          .map((row) => row.winget_id)
          .filter(Boolean)
      )
    );

    return NextResponse.json({
      deployedWingetIds,
      count: deployedWingetIds.length,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
