import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, createServerClient } from '@/lib/supabase';
import { getDb as getSqliteDb } from '@/lib/db/sqlite';
import { parseAccessToken } from '@/lib/auth-utils';

const MAX_BASE64_SIZE = 200 * 1024;
const ALLOWED_MIME_PATTERN = /^data:image\/(jpeg|png|webp);base64,/;

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    if (!isSupabaseConfigured()) {
      const db = getSqliteDb();
      const row = db.prepare('SELECT profile_image FROM user_profiles WHERE id = ?').get(user.userId) as { profile_image: string | null } | undefined;
      return NextResponse.json({ image: row?.profile_image ?? null });
    }

    const supabase = createServerClient();
    const { data, error } = await supabase.from('user_profiles').select('profile_image').eq('id', user.userId).single();
    if (error && error.code !== 'PGRST116') return NextResponse.json({ error: 'Failed to fetch profile image' }, { status: 500 });
    return NextResponse.json({ image: data?.profile_image ?? null });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    const body = await request.json();
    const { image } = body;
    if (!image || typeof image !== 'string') return NextResponse.json({ error: 'Image data is required' }, { status: 400 });
    if (!ALLOWED_MIME_PATTERN.test(image)) return NextResponse.json({ error: 'Invalid image format. Accepted: JPEG, PNG, WebP' }, { status: 400 });
    if (image.length > MAX_BASE64_SIZE) return NextResponse.json({ error: 'Image too large. Maximum size is 200KB.' }, { status: 400 });

    if (!isSupabaseConfigured()) {
      const db = getSqliteDb();
      db.prepare('INSERT INTO user_profiles (id, profile_image, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_image = excluded.profile_image, updated_at = excluded.updated_at')
        .run(user.userId, image, new Date().toISOString());
      return NextResponse.json({ success: true });
    }

    const supabase = createServerClient();
    const { error } = await supabase.from('user_profiles').update({ profile_image: image, updated_at: new Date().toISOString() }).eq('id', user.userId);
    if (error) return NextResponse.json({ error: 'Failed to update profile image' }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    if (!isSupabaseConfigured()) {
      const db = getSqliteDb();
      db.prepare('UPDATE user_profiles SET profile_image = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), user.userId);
      return NextResponse.json({ success: true });
    }

    const supabase = createServerClient();
    const { error } = await supabase.from('user_profiles').update({ profile_image: null, updated_at: new Date().toISOString() }).eq('id', user.userId);
    if (error) return NextResponse.json({ error: 'Failed to remove profile image' }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
