/**
 * Waitlist Leaderboard API
 *
 * @route GET /api/waitlist/leaderboard - Get waitlist leaderboard
 * @access Public
 *
 * @description
 * Returns top waitlist users ranked by points. By default results are sorted
 * by invite points, but you can set `pointsType=total` to sort by total
 * reputation points. Shows leaderboard with user rankings and points.
 * Supports pagination.
 *
 * @openapi
 * /api/waitlist/leaderboard:
 *   get:
 *     tags:
 *       - Waitlist
 *     summary: Get waitlist leaderboard
 *     description: Returns top waitlist users ranked by invite points (default) or total points with pagination
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-indexed)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of users per page (max 100)
 *       - in: query
 *         name: pointsType
 *         schema:
 *           type: string
 *           enum: [total, invite]
 *           default: invite
 *         description: Sort by total reputation points (total) or invite points (invite)
 *     responses:
 *       200:
 *         description: Leaderboard retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       username:
 *                         type: string
 *                         nullable: true
 *                       displayName:
 *                         type: string
 *                         nullable: true
 *                       invitePoints:
 *                         type: integer
 *                       reputationPoints:
 *                         type: integer
 *                       points:
 *                         type: integer
 *                       referralCount:
 *                         type: integer
 *                       rank:
 *                         type: integer
 *                 totalShown:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *
 * @example
 * ```typescript
 * const { leaderboard, page, totalPages } = await fetch('/api/waitlist/leaderboard?page=1&limit=10')
 *   .then(r => r.json());
 * ```
 *
 * @see {@link /lib/services/waitlist-service} Waitlist service
 */

import {
  getCache,
  setCache,
  successResponse,
  WaitlistService,
  withErrorHandling,
} from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";

type LeaderboardResponse = {
  leaderboard: Awaited<ReturnType<typeof WaitlistService.getTopWaitlistUsers>>;
  totalShown: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
  pointsType: "total" | "invite";
};

const CACHE_KEY_NAMESPACE = "waitlist:leaderboard";
// Increased cache to 5 minutes to reduce data transfer costs
const CACHE_TTL_MS = Number(
  process.env.WAITLIST_LEADERBOARD_CACHE_MS ?? 300_000,
); // 300s (5 min) default
const CACHE_TTL_SECONDS = Math.max(1, Math.floor(CACHE_TTL_MS / 1000));
const STALE_SECONDS = CACHE_TTL_SECONDS * 3;

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const page = Math.max(
    1,
    Number.parseInt(searchParams.get("page") || "1", 10),
  );
  const limit = Math.min(
    Number.parseInt(searchParams.get("limit") || "10", 10),
    100,
  ); // Cap at 100
  const pointsTypeParam = (searchParams.get("pointsType") || "").toLowerCase();
  const pointsType: "total" | "invite" =
    pointsTypeParam === "total" ? "total" : "invite";

  // Calculate offset for pagination
  const offset = (page - 1) * limit;

  // Cache key includes page, limit, and points type
  const cacheKey = `${pointsType}-${page}-${limit}`;

  if (CACHE_TTL_MS > 0) {
    const cached = await getCache<LeaderboardResponse>(cacheKey, {
      namespace: CACHE_KEY_NAMESPACE,
    });
    if (cached) {
      return successResponse(cached, 200, {
        "x-cache": "waitlist-leaderboard-hit",
        "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
        Vary: "Accept-Encoding",
      });
    }
  }

  logger.info(
    "Waitlist leaderboard request",
    { page, limit, offset, pointsType },
    "GET /api/waitlist/leaderboard",
  );

  const topUsers = await WaitlistService.getTopWaitlistUsers(
    limit,
    offset,
    pointsType,
  );

  // Calculate total pages (cap at 100 users for leaderboard display)
  // Determine hasMore based on whether we got a full page of results
  const maxUsers = 100;
  const totalPages = Math.ceil(maxUsers / limit);
  const hasMore = topUsers.length === limit && page < totalPages;

  const responseBody: LeaderboardResponse = {
    leaderboard: topUsers,
    totalShown: topUsers.length,
    page,
    totalPages,
    hasMore,
    pointsType,
  };

  if (CACHE_TTL_MS > 0) {
    await setCache(cacheKey, responseBody, {
      namespace: CACHE_KEY_NAMESPACE,
      ttl: CACHE_TTL_SECONDS,
    });
  }

  return successResponse(responseBody, 200, {
    "x-cache": "waitlist-leaderboard-miss",
    "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
    Vary: "Accept-Encoding",
  });
});
