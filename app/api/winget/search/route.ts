import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isSupabaseConfigured } from '@/lib/supabase';

// Removed 'export const runtime = 'edge'' - not compatible with SQLite (Node.js modules)
export const fetchCache = 'force-no-store';

interface CuratedAppResult {
  id: number;
  winget_id: string;
  name: string;
  publisher: string;
  latest_version: string;
  description: string | null;
  homepage: string | null;
  category: string | null;
  tags: string[] | null;
  icon_path: string | null;
  popularity_rank: number | null;
  installer_type: string | null;
  rank: number;
  app_source: string | null;
  store_package_id: string | null;
}

// Search curated apps
async function searchCachedPackages(
  query: string,
  limit: number,
  category?: string | null,
  sort: string = 'popular'
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: curatedData, error: curatedError } = await supabase.rpc(
    'search_curated_apps',
    {
      search_query: query,
      category_filter: category || null,
      result_limit: limit,
    }
  );

  if (curatedError) {
    return null;
  }

  if (curatedData && curatedData.length > 0) {
    let results = curatedData as CuratedAppResult[];

    // Apply secondary sorting if requested
    if (sort === 'name') {
      results = results.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'newest') {
      // newest first by id (higher id = newer entry)
      results = results.sort((a, b) => b.id - a.id);
    }
    // 'popular' keeps the RPC's default relevance + popularity ordering

    return {
      source: 'curated',
      data: results,
    };
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || searchParams.get('query');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const category = searchParams.get('category');
    const sort = searchParams.get('sort') || 'popular';

    if (!query || query.trim().length < 2) {
      return NextResponse.json(
        {
          error:
            'Query parameter "q" is required and must be at least 2 characters',
        },
        { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } }
      );
    }

    const sanitizedLimit = Math.min(limit, 100);

    // SQLite self-hosted fallback
    if (!isSupabaseConfigured()) {
      const Database = require('better-sqlite3');
      const db = new Database(process.env.DATABASE_PATH || './data/intuneget.db');

      const searchTerm = `%${query.trim()}%`;
      let sql = `SELECT * FROM winget_packages WHERE (name LIKE ? OR publisher LIKE ? OR id LIKE ?)`;
      const params: unknown[] = [searchTerm, searchTerm, searchTerm];

      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }

      sql += ' ORDER BY popularity_rank ASC NULLS LAST, name ASC LIMIT ?';
      params.push(sanitizedLimit);

      const rows = db.prepare(sql).all(...params) as Array<{
        id: string; name: string; publisher: string; latest_version: string;
        description: string; homepage: string; category: string; tags: string;
        icon_path: string; popularity_rank: number;
      }>;

      return NextResponse.json({
        query,
        count: rows.length,
        packages: rows.map((p) => ({
          id: p.id,
          name: p.name,
          publisher: p.publisher,
          version: p.latest_version || '',
          description: p.description,
          homepage: p.homepage,
          tags: p.tags ? JSON.parse(p.tags) : [],
          category: p.category,
          iconPath: p.icon_path,
          popularityRank: p.popularity_rank,
          appSource: 'win32',
        })),
        source: 'sqlite',
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }

    // Try curated apps search first
    const cachedResults = await searchCachedPackages(
      query,
      sanitizedLimit,
      category,
      sort
    );

    if (cachedResults && cachedResults.data.length > 0) {
      const curatedData = cachedResults.data;
      return NextResponse.json({
        query,
        count: curatedData.length,
        packages: curatedData.map((p) => ({
          id: p.winget_id,
          name: p.name,
          publisher: p.publisher,
          version: p.latest_version || '',
          description: p.description,
          homepage: p.homepage,
          tags: p.tags || [],
          category: p.category,
          iconPath: p.icon_path,
          popularityRank: p.popularity_rank,
          installerType: p.installer_type,
          appSource: p.app_source === 'store' ? 'store' : 'win32',
          packageIdentifier: p.store_package_id || undefined,
        })),
        source: 'curated',
      }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    return NextResponse.json({
      query,
      count: 0,
      packages: [],
      source: 'curated',
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to search packages' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  }
}
