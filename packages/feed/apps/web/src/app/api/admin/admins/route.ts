/**
 * Admin Management API
 *
 * @route GET /api/admin/admins - Get admin users
 * @access Admin
 *
 * @description
 * Returns list of all admin users with their details. Excludes NPCs/actors.
 * Admin only endpoint.
 */

import { requireAdmin, successResponse, withErrorHandling } from '@babylon/api';
import { and, db, eq, users } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  await requireAdmin(request);

  logger.info('Admin list requested', {}, 'GET /api/admin/admins');

  // Get all admin users
  const admins = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
      profileImageUrl: users.profileImageUrl,
      isActor: users.isActor,
      isAdmin: users.isAdmin,
      isBanned: users.isBanned,
      hasFarcaster: users.hasFarcaster,
      hasTwitter: users.hasTwitter,
      farcasterUsername: users.farcasterUsername,
      twitterUsername: users.twitterUsername,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActor, false)))
    .orderBy(users.createdAt);

  logger.info(`Found ${admins.length} admins`, {}, 'GET /api/admin/admins');

  return successResponse({
    admins,
    total: admins.length,
  });
});
