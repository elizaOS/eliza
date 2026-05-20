/**
 * Stats Widget API
 *
 * @route GET /api/feed/widgets/stats - Get platform statistics
 * @access Public
 *
 * @description
 * Returns platform-wide statistics including active players, AI agents, total posts,
 * and points in circulation. Aggregates data from users and actors with RLS support.
 *
 * @openapi
 * /api/feed/widgets/stats:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get platform statistics
 *     description: Returns platform-wide stats including players, agents, posts, and points
 *     parameters:
 *       - in: query
 *         name: includeMarkets
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include market statistics
 *       - in: query
 *         name: includeUsers
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include user statistics
 *       - in: query
 *         name: includePools
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include pool statistics
 *       - in: query
 *         name: includeVolume
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include volume statistics
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                   properties:
 *                     activePlayers:
 *                       type: integer
 *                       description: Active users in last 7 days
 *                     aiAgents:
 *                       type: integer
 *                       description: Total AI agents/actors
 *                     totalHoots:
 *                       type: integer
 *                       description: Total posts
 *                     pointsInCirculation:
 *                       type: string
 *                       description: Formatted points in circulation
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/feed/widgets/stats');
 * const { stats } = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import { optionalAuth, successResponse, withErrorHandling } from '@feed/api';
import {
  actorState,
  and,
  asPublic,
  asUser,
  count,
  eq,
  gte,
  posts,
  sql,
  sum,
  userActivityLogs,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger, StatsQuerySchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

interface FeedStats {
  activePlayers: number;
  aiAgents: number;
  totalHoots: number;
  pointsInCirculation: string;
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Validate query parameters
  const { searchParams } = new URL(request.url);
  const queryParams = {
    includeMarkets: searchParams.get('includeMarkets') || 'true',
    includeUsers: searchParams.get('includeUsers') || 'true',
    includePools: searchParams.get('includePools') || 'true',
    includeVolume: searchParams.get('includeVolume') || 'true',
  };
  StatsQuerySchema.parse(queryParams);

  const authUser = await optionalAuth(request).catch(() => null);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const queryStats = async (
    db: Parameters<Parameters<typeof asUser>[1]>[0]
  ) => {
    const [
      activePlayersResult,
      totalHootsResult,
      userPointsResult,
      actorPointsResult,
    ] = await Promise.all([
      db
        .select({
          count: sql<number>`COUNT(DISTINCT ${userActivityLogs.userId})::int`,
        })
        .from(userActivityLogs)
        .innerJoin(users, eq(users.id, userActivityLogs.userId))
        .where(
          and(
            eq(users.isActor, false),
            gte(userActivityLogs.activityDate, sevenDaysAgo)
          )
        ),
      db.select({ count: count() }).from(posts),
      db
        .select({ total: sum(users.virtualBalance) })
        .from(users)
        .where(eq(users.isActor, false)),
      db.select({ total: sum(actorState.tradingBalance) }).from(actorState),
    ]);

    return {
      activePlayers: Number(activePlayersResult[0]?.count ?? 0),
      aiAgents: StaticDataRegistry.getAllActors().length,
      totalHoots: Number(totalHootsResult[0]?.count ?? 0),
      userPoints: userPointsResult[0]?.total ?? '0',
      actorPoints: actorPointsResult[0]?.total ?? '0',
    };
  };

  const statsResult = authUser?.userId
    ? await asUser(authUser, queryStats)
    : await asPublic(queryStats);

  const totalPoints =
    Number(statsResult.userPoints) + Number(statsResult.actorPoints);
  const pointsInCirculation = formatPoints(totalPoints);

  const finalStats: FeedStats = {
    activePlayers: statsResult.activePlayers,
    aiAgents: statsResult.aiAgents,
    totalHoots: statsResult.totalHoots,
    pointsInCirculation,
  };

  logger.info(
    'Feed stats fetched successfully',
    finalStats,
    'GET /api/feed/widgets/stats'
  );

  return successResponse({
    success: true,
    stats: finalStats,
  });
});

function formatPoints(points: number): string {
  const num = Number.isFinite(points) ? Math.max(0, Math.round(points)) : 0;

  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M pts`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K pts`;
  }

  return `${num.toLocaleString()} pts`;
}
