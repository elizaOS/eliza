/**
 * Waitlist Position API
 *
 * @route GET /api/waitlist/position - Get waitlist position
 * @access Public
 *
 * @description
 * Returns user's waitlist position including leaderboard rank, percentile, points,
 * and referral statistics. Handles users not yet on waitlist gracefully.
 *
 * @openapi
 * /api/waitlist/position:
 *   get:
 *     tags:
 *       - Waitlist
 *     summary: Get waitlist position
 *     description: Returns user's waitlist position, rank, and points breakdown
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to check position for
 *     responses:
 *       200:
 *         description: Waitlist position retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 position:
 *                   type: integer
 *                   nullable: true
 *                   description: Leaderboard rank (null if not on waitlist)
 *                 leaderboardRank:
 *                   type: integer
 *                   nullable: true
 *                 waitlistPosition:
 *                   type: integer
 *                   nullable: true
 *                 totalAhead:
 *                   type: integer
 *                 totalCount:
 *                   type: integer
 *                 percentile:
 *                   type: number
 *                 inviteCode:
 *                   type: string
 *                 points:
 *                   type: number
 *                 pointsBreakdown:
 *                   type: object
 *                 referralCount:
 *                   type: integer
 *
 * @example
 * ```typescript
 * const { position, points } = await fetch('/api/waitlist/position?userId=user-id')
 *   .then(r => r.json());
 * ```
 *
 * @see {@link /lib/services/waitlist-service} Waitlist service
 */

import {
  authenticate,
  getCache,
  setCache,
  successResponse,
  WaitlistService,
  withErrorHandling,
} from "@feed/api";
import { and, db, desc, eq, referrals, users } from "@feed/db";
import { logger, toISO, toISOOrNull } from "@feed/shared";
import type { NextRequest } from "next/server";

type PositionResponse = {
  position: number | null;
  leaderboardRank?: number | null;
  waitlistPosition?: number | null;
  totalAhead?: number;
  totalCount?: number;
  percentile?: number;
  inviteCode?: string | null;
  points?: number;
  basePoints?: number;
  pointsBreakdown?: {
    total: number;
    invite: number;
    earned: number;
    bonus: number;
    base: number;
  };
  referralCount?: number;
  weeklyReferralCount?: number;
  weeklyLimit?: number;
  // Referral details
  invitedUsers?: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    email: string | null;
    farcasterUsername: string | null;
    twitterUsername: string | null;
    createdAt: string;
    status: "pending";
  }>;
  qualifiedUsers?: Array<{
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    createdAt: string;
    completedAt: string;
    status: "qualified";
  }>;
  invitedCount?: number;
  qualifiedCount?: number;
  totalReferralPoints?: number;
};

const CACHE_KEY_NAMESPACE = "waitlist:position";
const CACHE_TTL_MS = Number(process.env.WAITLIST_POSITION_CACHE_MS ?? 30_000); // 30s default (increased from 5s)
const CACHE_TTL_SECONDS = Math.max(1, Math.floor(CACHE_TTL_MS / 1000));
const STALE_SECONDS = CACHE_TTL_SECONDS * 3;
const MAX_REFERRALS_PER_LIST = 25; // Limit referral lists to prevent unbounded payloads

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require authentication - users can only see their own waitlist position
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId || authUser.userId;

  if (!userId) {
    throw new Error("User not found in database");
  }

  if (CACHE_TTL_MS > 0) {
    const cached = await getCache<PositionResponse>(userId, {
      namespace: CACHE_KEY_NAMESPACE,
    });
    if (cached) {
      return successResponse(cached, 200, {
        "x-cache": "waitlist-position-hit",
        "Cache-Control": `private, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
      });
    }
  }

  logger.info(
    "Waitlist position request",
    { userId },
    "GET /api/waitlist/position",
  );

  const position = await WaitlistService.getWaitlistPosition(userId);

  // If user doesn't exist or isn't on waitlist, return null gracefully
  // This handles new Steward users who haven't completed signup yet
  if (!position) {
    logger.info(
      "Waitlist position not found - user not on waitlist or doesn't exist yet",
      { userId },
      "GET /api/waitlist/position",
    );
    return successResponse(
      {
        position: null,
      },
      200,
      {
        "x-cache": "waitlist-position-miss",
      },
    );
  }

  // Derive base points (reputation total minus explicit buckets)
  const basePoints = Math.max(
    0,
    position.points -
      (position.invitePoints + position.earnedPoints + position.bonusPoints),
  );

  // Calculate weekly referral count and fetch referral details
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Get completed referrals (qualified users) - limit to prevent unbounded payloads
  // Use explicit column selection to avoid querying columns that may not exist in DB yet
  const completedReferralsRaw = await db
    .select({
      id: referrals.id,
      referredUserId: referrals.referredUserId,
      completedAt: referrals.completedAt,
      // Join user data
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      userCreatedAt: users.createdAt,
    })
    .from(referrals)
    .leftJoin(users, eq(referrals.referredUserId, users.id))
    .where(
      and(eq(referrals.referrerId, userId), eq(referrals.status, "completed")),
    )
    .orderBy(desc(referrals.completedAt))
    .limit(MAX_REFERRALS_PER_LIST);

  const weeklyReferralCount = completedReferralsRaw.filter(
    (r) => r.completedAt && r.completedAt >= oneWeekAgo,
  ).length;

  // Get pending referrals (invited but not qualified) - limit to prevent unbounded payloads
  const pendingReferredUsers = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      email: users.email,
      farcasterUsername: users.farcasterUsername,
      twitterUsername: users.twitterUsername,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(eq(users.referredBy, userId), eq(users.profileComplete, false)))
    .orderBy(desc(users.createdAt))
    .limit(MAX_REFERRALS_PER_LIST);

  const WEEKLY_REFERRAL_LIMIT = 10;

  // Format referral users
  const invitedUsers = pendingReferredUsers.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    profileImageUrl: u.profileImageUrl,
    email: u.email,
    farcasterUsername: u.farcasterUsername,
    twitterUsername: u.twitterUsername,
    createdAt: toISO(u.createdAt),
    status: "pending" as const,
  }));

  const qualifiedUsers = completedReferralsRaw
    .filter((r) => r.userId !== null)
    .map((r) => ({
      id: r.userId as string,
      username: r.username,
      displayName: r.displayName,
      profileImageUrl: r.profileImageUrl,
      createdAt: toISOOrNull(r.userCreatedAt) ?? new Date().toISOString(),
      completedAt: toISOOrNull(r.completedAt) ?? new Date().toISOString(),
      status: "qualified" as const,
    }));

  const responseBody: PositionResponse = {
    // IMPORTANT: Return leaderboardRank as "position" for UI compatibility
    position: position.leaderboardRank, // Dynamic rank based on invite points
    leaderboardRank: position.leaderboardRank,
    waitlistPosition: position.waitlistPosition, // Historical record
    totalAhead: position.totalAhead,
    totalCount: position.totalCount,
    percentile: position.percentile,
    inviteCode: position.inviteCode,
    points: position.points, // Full reputation points
    basePoints,
    pointsBreakdown: {
      total: position.points, // Should match points (reputationPoints)
      invite: position.invitePoints,
      earned: position.earnedPoints,
      bonus: position.bonusPoints,
      base: basePoints,
    },
    referralCount: position.referralCount,
    weeklyReferralCount,
    weeklyLimit: WEEKLY_REFERRAL_LIMIT,
    // Referral details
    invitedUsers,
    qualifiedUsers,
    invitedCount: invitedUsers.length,
    qualifiedCount: qualifiedUsers.length,
    totalReferralPoints: position.invitePoints, // Total points from referrals
  };

  if (CACHE_TTL_MS > 0) {
    await setCache(userId, responseBody, {
      namespace: CACHE_KEY_NAMESPACE,
      ttl: CACHE_TTL_SECONDS,
    });
  }

  return successResponse(responseBody, 200, {
    "x-cache": "waitlist-position-miss",
    "Cache-Control": `private, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
  });
});
