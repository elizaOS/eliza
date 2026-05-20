/**
 * Admin Whitelist Management API
 *
 * @route GET /api/admin/whitelist - List whitelisted users with stats
 * @route POST /api/admin/whitelist - Add a user to the whitelist
 * @route DELETE /api/admin/whitelist - Remove (revoke) a user from the whitelist
 * @access Admin
 */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import type { WhitelistSource } from '@feed/api/services/whitelist-service';
import {
  addToWhitelist,
  getWhitelistStats,
  listWhitelistEntries,
  removeFromWhitelist,
} from '@feed/api/services/whitelist-service';
import { db, eq, or, sql, users } from '@feed/db';
import { type NextRequest, NextResponse } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source') as WhitelistSource | null;
  const search = searchParams.get('search') ?? undefined;
  const includeRevoked = searchParams.get('includeRevoked') === 'true';

  const [entries, stats] = await Promise.all([
    listWhitelistEntries({
      source: source ?? undefined,
      search,
      includeRevoked,
    }),
    getWhitelistStats(),
  ]);

  return successResponse({ entries, stats });
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);

  const body = await request.json();
  const { userId, source, reason } = body as {
    userId: string;
    source?: WhitelistSource;
    reason?: string;
  };

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  // Strip leading @ and resolve by userId or username
  const identifier = userId.trim().replace(/^@/, '');

  const [user] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(
      or(
        eq(users.id, identifier),
        sql`lower(${users.username}) = lower(${identifier})`
      )
    )
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const result = await addToWhitelist({
    userId: user.id,
    source: source ?? 'admin_manual',
    reason,
    grantedBy: admin.dbUserId ?? undefined,
  });

  if (result.alreadyExists) {
    return NextResponse.json(
      { error: 'User is already whitelisted' },
      { status: 409 }
    );
  }

  return successResponse({
    success: true,
    id: result.id,
    username: user.username,
  });
});

export const DELETE = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const body = await request.json();
  const { userId } = body as { userId: string };

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  const result = await removeFromWhitelist(userId);

  if (!result.removed) {
    return NextResponse.json(
      { error: 'User not found in whitelist or already revoked' },
      { status: 404 }
    );
  }

  return successResponse({ success: true, removedUserId: userId });
});
