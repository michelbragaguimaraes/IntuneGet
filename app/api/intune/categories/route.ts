/**
 * Intune Categories API Route
 * Fetches available Intune mobile app categories for deployment configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import { parseAccessToken } from '@/lib/auth-utils';
import { getMobileAppCategories } from '@/lib/intune-api';

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    let tenantId = user.tenantId;

    if (isSupabaseConfigured()) {
      const supabase = createServerClient();
      const mspTenantId = request.headers.get('X-MSP-Tenant-Id');
      const tenantResolution = await resolveTargetTenantId({ supabase, userId: user.userId, tokenTenantId: user.tenantId, requestedTenantId: mspTenantId });
      if (tenantResolution.errorResponse) return tenantResolution.errorResponse;
      tenantId = tenantResolution.tenantId;
      const { data: consentData, error: consentError } = await supabase.from('tenant_consent').select('*').eq('tenant_id', tenantId).eq('is_active', true).single();
      if (consentError || !consentData) return NextResponse.json({ error: 'Admin consent not found.' }, { status: 403 });
    }

    const graphToken = await getServicePrincipalToken(tenantId);
    if (!graphToken) {
      return NextResponse.json(
        { error: 'Failed to get Graph API token' },
        { status: 500 }
      );
    }

    const categories = await getMobileAppCategories(graphToken);

    return NextResponse.json({
      categories,
      count: categories.length,
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch Intune app categories' },
      { status: 500 }
    );
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
