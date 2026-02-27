import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getCategories } from '@/lib/winget-api';
import { isSupabaseConfigured } from '@/lib/supabase';

// Removed 'export const runtime = 'edge'' - not compatible with SQLite (Node.js modules)
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET() {
  try {
    // SQLite self-hosted fallback
    if (!isSupabaseConfigured()) {
      const Database = require('better-sqlite3');
      const db = new Database(process.env.DATABASE_PATH || './data/intuneget.db');

      const rows = db.prepare(`
        SELECT category, COUNT(*) as count
        FROM winget_packages
        WHERE category IS NOT NULL
        GROUP BY category
        ORDER BY count DESC
      `).all() as Array<{ category: string; count: number }>;

      const totalApps = (db.prepare('SELECT COUNT(*) as total FROM winget_packages').get() as { total: number }).total;

      return NextResponse.json({
        count: rows.length,
        totalApps,
        categories: rows.map((r) => ({ name: r.category, count: r.count })),
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }

    const categories = await getCategories();

    // Get actual total count of verified apps (not just sum of categories)
    let totalApps = categories.reduce((sum, cat) => sum + cat.count, 0);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { count } = await supabase
        .from('curated_apps')
        .select('*', { count: 'exact', head: true })
        .eq('is_verified', true);

      if (count !== null) {
        totalApps = count;
      }
    }

    return NextResponse.json({
      count: categories.length,
      totalApps,
      categories,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch categories' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  }
}
