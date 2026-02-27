/**
 * Mark All Notifications as Read API
 * POST - Mark all notifications for the current user as read
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { markAllNotificationsAsRead } from '@/lib/notification-service';
import { isSupabaseConfigured } from '@/lib/supabase';

/**
 * POST /api/notifications/mark-all-read
 * Mark all notifications as read for the current user
 */
export async function POST(request: NextRequest) {
  try {    // Self-hosted SQLite stub: return empty/default when Supabase not configured
    if (!isSupabaseConfigured()) {
      return NextResponse.json({ data: [], items: [], count: 0, message: 'Feature requires Supabase configuration' }, { status: 200 });
    }

    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    await markAllNotificationsAsRead(user.userId);

    return NextResponse.json({
      success: true,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
