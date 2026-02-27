/**
 * Unmanaged Apps API Route
 * Fetches detected apps from Intune and matches them to WinGet packages
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { parseAccessToken } from '@/lib/auth-utils';
import { matchDiscoveredApp, filterUserApps, isSystemApp, normalizeAppName } from '@/lib/matching/app-matcher';
import { compareVersions } from '@/lib/version-compare';
import type {
  GraphUnmanagedApp,
  UnmanagedApp,
  UnmanagedAppsResponse,
  UnmanagedAppsStats,
  MatchStatus
} from '@/types/unmanaged';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

import type { Database, Json } from '@/types/database';

// Database row types from Database types
type DiscoveredAppCacheRow = Database['public']['Tables']['discovered_apps_cache']['Row'];
type ClaimedAppRow = Pick<Database['public']['Tables']['claimed_apps']['Row'], 'discovered_app_id' | 'status'>;
type ManualMappingRow = Database['public']['Tables']['manual_app_mappings']['Row'];

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Get query params
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const includeSystem = searchParams.get('includeSystem') === 'true';

    // In SQLite mode, skip MSP tenant resolution and use token tenant directly
    let tenantId = user.tenantId;
    const supabase = isSupabaseConfigured() ? createServerClient() : null as any;
    if (isSupabaseConfigured()) {
      const supabase = createServerClient();
      const mspTenantId = request.headers.get('X-MSP-Tenant-Id');
      const tenantResolution = await resolveTargetTenantId({ supabase, userId: user.userId, tokenTenantId: user.tenantId, requestedTenantId: mspTenantId });
      if (tenantResolution.errorResponse) { return tenantResolution.errorResponse; }
      Object.assign({ tenantId: tenantResolution.tenantId });
    }

    // Verify admin consent (skipped in SQLite mode)
    if (isSupabaseConfigured()) {
      const { data: consentData, error: consentError } = await supabase
        .from('tenant_consent')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .single();
      if (consentError || !consentData) {
        return NextResponse.json({ error: 'Admin consent not found. Please complete the admin consent flow.' }, { status: 403 });
      }
    }

    // Check cache first (unless force refresh) - Supabase only
    if (!forceRefresh && isSupabaseConfigured()) {
      const { data: cachedApps } = await supabase
        .from('discovered_apps_cache')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('device_count', { ascending: false });

      if (cachedApps && cachedApps.length > 0) {
        const lastSynced = new Date(cachedApps[0].last_synced).getTime();
        const isCacheValid = Date.now() - lastSynced < CACHE_DURATION_MS;

        if (isCacheValid) {
          // Get claimed apps for this tenant
          const { data: claimedApps } = await supabase
            .from('claimed_apps')
            .select('discovered_app_id, status')
            .eq('tenant_id', tenantId);

          const claimedMap = new Map(
            claimedApps?.map(c => [c.discovered_app_id, c.status]) || []
          );

          const apps: UnmanagedApp[] = cachedApps
            .filter(app => includeSystem || !isSystemApp(app.app_data as unknown as GraphUnmanagedApp))
            .filter(app => {
              // Only hide deployed apps - pending/deploying/failed should remain visible
              const status = claimedMap.get(app.discovered_app_id);
              return status !== 'deployed';
            })
            .map(cached => ({
              id: cached.id,
              discoveredAppId: cached.discovered_app_id,
              displayName: cached.display_name,
              version: cached.version,
              publisher: cached.publisher,
              deviceCount: cached.device_count,
              platform: cached.platform,
              matchStatus: cached.match_status as MatchStatus,
              matchedPackageId: cached.matched_package_id,
              matchedPackageName: null,
              matchConfidence: cached.match_confidence,
              isClaimed: claimedMap.has(cached.discovered_app_id),
              claimStatus: claimedMap.get(cached.discovered_app_id) as UnmanagedApp['claimStatus'],
              lastSynced: cached.last_synced,
            }));

          return NextResponse.json({
            apps,
            total: apps.length,
            lastSynced: cachedApps[0].last_synced,
            fromCache: true,
          } as UnmanagedAppsResponse);
        }
      }
    }

    // Fetch fresh data from Graph API
    const graphToken = await getServicePrincipalToken(tenantId);
    if (!graphToken) {
      return NextResponse.json(
        { error: 'Failed to get Graph API token' },
        { status: 500 }
      );
    }

    // Fetch unmanaged apps with pagination
    const graphApps: GraphUnmanagedApp[] = [];
    let nextUrl: string | null = `${GRAPH_API_BASE}/deviceManagement/detectedApps?$top=100&$orderby=deviceCount desc`;

    while (nextUrl) {
      const graphResponse: Response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${graphToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!graphResponse.ok) {
        const errorText = await graphResponse.text();

        // Check for permission error
        if (graphResponse.status === 403 && errorText.includes('DeviceManagementManagedDevices')) {
          return NextResponse.json(
            {
              error: 'Missing required permission: DeviceManagementManagedDevices.Read.All. Please add this permission to your Azure AD app registration and grant admin consent.',
              permissionRequired: 'DeviceManagementManagedDevices.Read.All'
            },
            { status: 403 }
          );
        }

        return NextResponse.json(
          { error: 'Failed to fetch unmanaged apps from Intune' },
          { status: graphResponse.status }
        );
      }

      const graphData: { value: Record<string, unknown>[]; '@odata.nextLink'?: string } = await graphResponse.json();
      const pageApps = (graphData.value || []).map((app) => ({
        id: app.id as string,
        displayName: app.displayName as string,
        version: app.version as string | null,
        publisher: app.publisher as string | null,
        deviceCount: app.deviceCount as number,
        platform: mapPlatform(app.platform as string),
        sizeInByte: app.sizeInByte as number | undefined,
      }));

      graphApps.push(...pageApps);
      nextUrl = graphData['@odata.nextLink'] || null;
    }

    // Consolidate apps: group by normalized name+publisher, keep newest version, sum device counts
    const appGroups = new Map<string, GraphUnmanagedApp>();
    for (const app of graphApps) {
      const key = `${normalizeAppName(app.displayName)}::${(app.publisher || '').toLowerCase().trim()}`;
      const existing = appGroups.get(key);
      if (!existing) {
        appGroups.set(key, { ...app });
      } else {
        existing.deviceCount += app.deviceCount;
        if (app.version && (!existing.version || compareVersions(app.version, existing.version) > 0)) {
          existing.id = app.id;
          existing.displayName = app.displayName;
          existing.version = app.version;
        }
      }
    }
    const consolidatedApps = [...appGroups.values()];

    // Filter to Windows apps only
    const windowsApps = consolidatedApps.filter(app => app.platform === 'windows');

    // Filter user apps (remove system/framework apps) unless includeSystem
    const filteredApps = includeSystem ? windowsApps : filterUserApps(windowsApps);

    // Match apps to WinGet packages
    const now = new Date().toISOString();
    const unmanagedApps: UnmanagedApp[] = [];

    // Get claimed apps
    const { data: claimedApps } = isSupabaseConfigured() ? await supabase
      .from('claimed_apps')
      .select('discovered_app_id, status')
      .eq('tenant_id', tenantId) : { data: [] };

    const claimedMap = new Map(
      claimedApps?.map(c => [c.discovered_app_id, c.status]) || []
    );

    // Get manual mappings for this tenant
    const { data: manualMappings } = isSupabaseConfigured() ? await supabase
      .from('manual_app_mappings')
      .select('*')
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);

    const manualMappingMap = new Map(
      manualMappings?.map(m => [m.discovered_app_name.toLowerCase(), m]) || []
    );

    // Process each app
    for (const app of filteredApps) {
      // Check for manual mapping first
      const normalizedName = app.displayName.toLowerCase().trim();
      const manualMapping = manualMappingMap.get(normalizedName);

      let matchResult;
      if (manualMapping) {
        matchResult = {
          status: 'matched' as const,
          wingetId: manualMapping.winget_package_id,
          wingetName: null,
          confidence: 1.0,
          partialMatches: [],
        };
      } else {
        matchResult = matchDiscoveredApp(app);
      }

      unmanagedApps.push({
        id: `${tenantId}-${app.id}`,
        discoveredAppId: app.id,
        displayName: app.displayName,
        version: app.version,
        publisher: app.publisher,
        deviceCount: app.deviceCount,
        platform: app.platform,
        matchStatus: matchResult.status,
        matchedPackageId: matchResult.wingetId,
        matchedPackageName: matchResult.wingetName,
        matchConfidence: matchResult.confidence,
        partialMatches: matchResult.partialMatches,
        isClaimed: claimedMap.has(app.id),
        claimStatus: claimedMap.get(app.id) as UnmanagedApp['claimStatus'],
        lastSynced: now,
      });
    }

    // Update cache (upsert)
    type DiscoveredAppsCacheInsert = Database['public']['Tables']['discovered_apps_cache']['Insert'];
    const cacheRecords: DiscoveredAppsCacheInsert[] = unmanagedApps.map(app => ({
      user_id: user.userId,
      tenant_id: tenantId,
      discovered_app_id: app.discoveredAppId,
      display_name: app.displayName,
      version: app.version,
      publisher: app.publisher,
      device_count: app.deviceCount,
      platform: app.platform,
      matched_package_id: app.matchedPackageId,
      match_confidence: app.matchConfidence,
      match_status: app.matchStatus,
      app_data: filteredApps.find(a => a.id === app.discoveredAppId) as unknown as Json,
      last_synced: now,
    }));

    // Delete old cache entries for this tenant and insert new ones
    if (isSupabaseConfigured()) await supabase
      .from('discovered_apps_cache')
      .delete()
      .eq('tenant_id', tenantId);

    if (cacheRecords.length > 0) {
      await supabase
        .from('discovered_apps_cache')
        .upsert(cacheRecords, { onConflict: 'tenant_id,discovered_app_id' });
    }

    // Only hide deployed apps - pending/deploying/failed should remain visible
    const visibleApps = unmanagedApps.filter(app => {
      const status = claimedMap.get(app.discoveredAppId);
      return status !== 'deployed';
    });

    return NextResponse.json({
      apps: visibleApps,
      total: visibleApps.length,
      lastSynced: now,
      fromCache: false,
    } as UnmanagedAppsResponse);
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch unmanaged apps' },
      { status: 500 }
    );
  }
}

/**
 * Get statistics for unmanaged apps
 */
export async function POST(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // In SQLite mode, skip MSP tenant resolution and use token tenant directly
    let tenantId = user.tenantId;
    const supabase = isSupabaseConfigured() ? createServerClient() : null as any;
    if (isSupabaseConfigured()) {
      const supabase = createServerClient();
      const mspTenantId = request.headers.get('X-MSP-Tenant-Id');
      const tenantResolution = await resolveTargetTenantId({ supabase, userId: user.userId, tokenTenantId: user.tenantId, requestedTenantId: mspTenantId });
      if (tenantResolution.errorResponse) { return tenantResolution.errorResponse; }
      Object.assign({ tenantId: tenantResolution.tenantId });
    }

    // Get cached apps
    const { data: cachedApps } = await supabase
      .from('discovered_apps_cache')
      .select('match_status, device_count, discovered_app_id, display_name, publisher, matched_package_id')
      .eq('tenant_id', tenantId);

    // Get claimed apps with status
    const { data: claimedApps } = isSupabaseConfigured() ? await supabase
      .from('claimed_apps')
      .select('discovered_app_id, status')
      .eq('tenant_id', tenantId) : { data: [] };

    const claimedMap = new Map(
      claimedApps?.map(c => [c.discovered_app_id, c.status]) || []
    );

    // Filter cached apps to exclude deployed apps and Microsoft apps for stats calculation
    // Only deployed apps are hidden - pending/deploying/failed remain visible
    const visibleApps = cachedApps?.filter(a => {
      // Only exclude deployed apps (not pending/deploying/failed)
      const status = claimedMap.get(a.discovered_app_id);
      if (status === 'deployed') return false;

      // Exclude Microsoft apps (consistent with frontend filtering)
      const publisherLower = (a.publisher || '').toLowerCase();
      const packageIdLower = (a.matched_package_id || '').toLowerCase();
      const displayNameLower = (a.display_name || '').toLowerCase();

      const isMicrosoft =
        publisherLower.includes('microsoft') ||
        packageIdLower.startsWith('microsoft.') ||
        displayNameLower.startsWith('microsoft ');

      return !isMicrosoft;
    }) || [];

    const stats: UnmanagedAppsStats = {
      total: visibleApps.length,
      matched: visibleApps.filter(a => a.match_status === 'matched').length,
      partial: visibleApps.filter(a => a.match_status === 'partial').length,
      unmatched: visibleApps.filter(a => a.match_status === 'unmatched').length,
      claimed: Array.from(claimedMap.values()).filter(s => s === 'deployed').length,  // Only count deployed
      totalDevices: visibleApps.reduce((sum, a) => sum + (a.device_count || 0), 0),
    };

    return NextResponse.json(stats);
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}

/**
 * Map Graph API platform string to our format
 */
function mapPlatform(platform: string | undefined): GraphUnmanagedApp['platform'] {
  switch (platform?.toLowerCase()) {
    case 'windows':
      return 'windows';
    case 'macos':
    case 'macosx':
      return 'macOS';
    case 'android':
      return 'android';
    case 'ios':
      return 'iOS';
    default:
      return 'unknown';
  }
}

/**
 * Get access token for the service principal using client credentials flow
 */
async function getServicePrincipalToken(tenantId: string): Promise<string | null> {
  const clientId = process.env.AZURE_CLIENT_ID || process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET || process.env.AZURE_AD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  try {
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      }
    );

    if (!tokenResponse.ok) {
      return null;
    }

    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
  } catch {
    return null;
  }
}
