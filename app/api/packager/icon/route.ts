/**
 * Packager Icon API
 * Returns the icon URL for a given WinGet ID, looked up from the local DB.
 * Used by the packager to fetch app icons before uploading to Intune.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyPackagerApiKey } from '@/lib/db';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getDb as getSqliteDb } from '@/lib/db/sqlite';

function verifyPackagerAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  return verifyPackagerApiKey(authHeader.slice(7));
}

/**
 * GET /api/packager/icon?wingetId=Notepad%2B%2B.Notepad%2B%2B
 * Returns { iconUrl: string | null }
 */
export async function GET(request: NextRequest) {
  if (!verifyPackagerAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const wingetId = request.nextUrl.searchParams.get('wingetId');
  if (!wingetId) {
    return NextResponse.json({ error: 'wingetId is required' }, { status: 400 });
  }

  try {
    if (isSupabaseConfigured()) {
      // Supabase path
      const { createServerClient } = await import('@/lib/supabase');
      const supabase = createServerClient();
      const { data, error } = await supabase
        .from('winget_packages')
        .select('icon_path')
        .eq('winget_id', wingetId)
        .single();

      if (error || !data) {
        return NextResponse.json({ iconUrl: null });
      }
      return NextResponse.json({ iconUrl: data.icon_path ?? null });
    } else {
      // SQLite path
      const db = getSqliteDb();
      const row = db.prepare(
        'SELECT icon_path FROM winget_packages WHERE id = ? LIMIT 1'
      ).get(wingetId) as { icon_path: string | null } | undefined;

      return NextResponse.json({ iconUrl: row?.icon_path ?? null });
    }
  } catch (err) {
    console.error('[packager/icon] Error:', err);
    return NextResponse.json({ iconUrl: null });
  }
}
