/**
 * Admin: Sync Winget Catalog to SQLite
 * Responds immediately and runs sync in background to avoid proxy timeouts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured } from '@/lib/supabase';

const WINGET_INDEX_URL =
  'https://raw.githubusercontent.com/svrooij/winget-pkgs-index/main/index.v2.json';

interface WingetIndexPackage {
  PackageIdentifier: string;
  PackageName?: string;
  Publisher?: string;
  PackageVersion?: string;
  ShortDescription?: string;
  Homepage?: string;
  Tags?: string[];
}

interface WingetIndex {
  Packages?: WingetIndexPackage[];
  packages?: WingetIndexPackage[];
}

async function runSync() {
  console.log('[sync-catalog] Fetching winget index from', WINGET_INDEX_URL);
  const response = await fetch(WINGET_INDEX_URL);
  if (!response.ok) {
    console.error('[sync-catalog] Failed to fetch:', response.status);
    return;
  }

  const index = (await response.json()) as WingetIndex;
  const packages: WingetIndexPackage[] = index.Packages || index.packages || [];

  if (!Array.isArray(packages) || packages.length === 0) {
    console.error('[sync-catalog] No packages in index');
    return;
  }

  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH || './data/intuneget.db');

  db.exec(`
    CREATE TABLE IF NOT EXISTS winget_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      publisher TEXT,
      latest_version TEXT,
      description TEXT,
      homepage TEXT,
      category TEXT,
      tags TEXT,
      icon_path TEXT,
      popularity_rank INTEGER,
      last_synced_at TEXT
    )
  `);

  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO winget_packages (id, name, publisher, latest_version, description, homepage, tags, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      publisher = excluded.publisher,
      latest_version = excluded.latest_version,
      description = excluded.description,
      homepage = excluded.homepage,
      tags = excluded.tags,
      last_synced_at = excluded.last_synced_at
  `);

  const insertMany = db.transaction((pkgs: WingetIndexPackage[]) => {
    let inserted = 0;
    for (const pkg of pkgs) {
      if (!pkg.PackageIdentifier) continue;
      upsert.run(
        pkg.PackageIdentifier,
        pkg.PackageName || pkg.PackageIdentifier,
        pkg.Publisher || null,
        pkg.PackageVersion || null,
        pkg.ShortDescription || null,
        pkg.Homepage || null,
        pkg.Tags ? JSON.stringify(pkg.Tags) : null,
        now
      );
      inserted++;
    }
    return inserted;
  });

  const count = insertMany(packages);
  console.log(`[sync-catalog] Done — upserted ${count} packages into SQLite`);
  db.close();
}

export async function POST(request: NextRequest) {
  if (isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Catalog sync is only available in self-hosted (SQLite) mode' },
      { status: 400 }
    );
  }

  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret) {
    const authHeader = request.headers.get('Authorization');
    const provided = authHeader?.replace(/^Bearer\s+/i, '');
    if (provided !== adminSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Fire and forget — respond immediately so proxy doesn't timeout
  runSync().catch(err => console.error('[sync-catalog] Background error:', err));

  return NextResponse.json({
    success: true,
    message: 'Catalog sync started in background. Check server logs for progress.',
  });
}

export async function GET() {
  if (isSupabaseConfigured()) {
    return NextResponse.json({ mode: 'supabase', syncAvailable: false });
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_PATH || './data/intuneget.db');

    let count = 0;
    let lastSync: string | null = null;

    try {
      const row = db.prepare(`SELECT COUNT(*) as count, MAX(last_synced_at) as last_sync FROM winget_packages`).get() as { count: number; last_sync: string | null };
      count = row.count;
      lastSync = row.last_sync;
    } catch {
      // Table might not exist yet
    }

    db.close();
    return NextResponse.json({ mode: 'sqlite', syncAvailable: true, packageCount: count, lastSync });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
