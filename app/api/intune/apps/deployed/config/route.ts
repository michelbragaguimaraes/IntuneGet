import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { parseAccessToken } from '@/lib/auth-utils';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { getDb as getSqliteDb } from '@/lib/db/sqlite';

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const wingetId = searchParams.get('wingetId');

    if (!wingetId) {
      return NextResponse.json(
        { error: 'wingetId parameter required' },
        { status: 400 }
      );
    }

    if (!isSupabaseConfigured()) {
      const db = getSqliteDb();
      const row = db.prepare(`
        SELECT package_config, completed_at, intune_app_id FROM packaging_jobs
        WHERE user_id = ? AND winget_id = ? AND status = 'deployed'
        ORDER BY completed_at DESC LIMIT 1
      `).get(user.userId, wingetId) as { package_config: string; completed_at: string; intune_app_id: string } | undefined;

      return NextResponse.json({
        config: row?.package_config ? JSON.parse(row.package_config) : null,
        deployedAt: row?.completed_at || null,
        intuneAppId: row?.intune_app_id || null,
      });
    }

    const supabase = createServerClient();
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');
    const tenantResolution = await resolveTargetTenantId({ supabase, userId: user.userId, tokenTenantId: user.tenantId, requestedTenantId: mspTenantId });
    if (tenantResolution.errorResponse) return tenantResolution.errorResponse;

    const { data, error } = await supabase
      .from('packaging_jobs')
      .select('package_config, completed_at, intune_app_id')
      .eq('user_id', user.userId)
      .eq('tenant_id', tenantResolution.tenantId)
      .eq('winget_id', wingetId)
      .eq('status', 'deployed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ config: null, deployedAt: null, intuneAppId: null });
    }

    return NextResponse.json({
      config: data.package_config,
      deployedAt: data.completed_at,
      intuneAppId: data.intune_app_id || null,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
