/**
 * User Lookup by Username API
 *
 * @route GET /api/users/by-username/[username] - Get user by username
 * @access Public
 *
 * @description
 * Retrieves user profile by username with comprehensive profile data including
 * stats, social connections, on-chain status, and social media links.
 *
 * @openapi
 * /api/users/by-username/{username}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user by username
 *     description: Returns complete user profile by username lookup
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to lookup
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     username:
 *                       type: string
 *                     displayName:
 *                       type: string
 *                     bio:
 *                       type: string
 *                     profileImageUrl:
 *                       type: string
 *                     stats:
 *                       type: object
 *                       properties:
 *                         positions:
 *                           type: integer
 *                         comments:
 *                           type: integer
 *                         reactions:
 *                           type: integer
 *                         followers:
 *                           type: integer
 *                         following:
 *                           type: integer
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/users/by-username/alice');
 * const { user } = await response.json();
 * console.log(`${user.displayName} (@${user.username})`);
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  NotFoundError,
  optionalAuth,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import {
  comments,
  count,
  db,
  eq,
  follows,
  positions,
  reactions,
  sql,
  users,
} from "@polyagent/db";
import { logger, UsernameParamSchema } from "@polyagent/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/users/by-username/[username]
 * Get user profile by username
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ username: string }> },
  ) => {
    const params = await context.params;
    const { username } = UsernameParamSchema.parse(params);

    // Optional authentication
    await optionalAuth(request);

    // Get user profile by username (case-insensitive)
    const [dbUser] = await db
      .select({
        id: users.id,
        walletAddress: users.walletAddress,
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
        profileImageUrl: users.profileImageUrl,
        coverImageUrl: users.coverImageUrl,
        isActor: users.isActor,
        profileComplete: users.profileComplete,
        hasUsername: users.hasUsername,
        hasBio: users.hasBio,
        hasProfileImage: users.hasProfileImage,
        onChainRegistered: users.onChainRegistered,
        nftTokenId: users.nftTokenId,
        virtualBalance: users.virtualBalance,
        lifetimePnL: users.lifetimePnL,
        reputationPoints: users.reputationPoints,
        referralCount: users.referralCount,
        referralCode: users.referralCode,
        hasFarcaster: users.hasFarcaster,
        hasTwitter: users.hasTwitter,
        farcasterUsername: users.farcasterUsername,
        twitterUsername: users.twitterUsername,
        usernameChangedAt: users.usernameChangedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1);

    if (!dbUser) {
      throw new NotFoundError("User", username);
    }

    // Get counts for stats
    const [
      [positionCount],
      [commentCount],
      [reactionCount],
      [followerCount],
      [followingCount],
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(positions)
        .where(eq(positions.userId, dbUser.id)),
      db
        .select({ count: count() })
        .from(comments)
        .where(eq(comments.authorId, dbUser.id)),
      db
        .select({ count: count() })
        .from(reactions)
        .where(eq(reactions.userId, dbUser.id)),
      db
        .select({ count: count() })
        .from(follows)
        .where(eq(follows.followingId, dbUser.id)),
      db
        .select({ count: count() })
        .from(follows)
        .where(eq(follows.followerId, dbUser.id)),
    ]);

    logger.info(
      "User profile fetched by username",
      { username, userId: dbUser.id },
      "GET /api/users/by-username/[username]",
    );

    return successResponse({
      user: {
        id: dbUser.id,
        walletAddress: dbUser.walletAddress,
        username: dbUser.username,
        displayName: dbUser.displayName,
        bio: dbUser.bio,
        profileImageUrl: dbUser.profileImageUrl,
        coverImageUrl: dbUser.coverImageUrl,
        isActor: dbUser.isActor,
        profileComplete: dbUser.profileComplete,
        hasUsername: dbUser.hasUsername,
        hasBio: dbUser.hasBio,
        hasProfileImage: dbUser.hasProfileImage,
        onChainRegistered: dbUser.onChainRegistered,
        nftTokenId: dbUser.nftTokenId,
        virtualBalance: Number(dbUser.virtualBalance ?? 0),
        lifetimePnL: Number(dbUser.lifetimePnL ?? 0),
        reputationPoints: dbUser.reputationPoints,
        referralCount: dbUser.referralCount,
        referralCode: dbUser.referralCode,
        hasFarcaster: dbUser.hasFarcaster,
        hasTwitter: dbUser.hasTwitter,
        farcasterUsername: dbUser.farcasterUsername,
        twitterUsername: dbUser.twitterUsername,
        createdAt: dbUser.createdAt.toISOString(),
        stats: {
          positions: Number(positionCount?.count || 0),
          comments: Number(commentCount?.count || 0),
          reactions: Number(reactionCount?.count || 0),
          followers: Number(followerCount?.count || 0),
          following: Number(followingCount?.count || 0),
        },
      },
    });
  },
);
