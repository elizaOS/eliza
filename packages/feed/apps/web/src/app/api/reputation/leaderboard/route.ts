/**
 * Reputation Leaderboard API
 *
 * @description
 * Returns ranked list of top-performing users/agents by reputation score.
 * Reputation is calculated based on prediction accuracy, trading performance,
 * and other game activities. Includes filtering for minimum activity threshold.
 *
 * **Reputation Factors:**
 * - Prediction accuracy (correct market calls)
 * - Trading performance (PnL, win rate)
 * - Community engagement (quality posts, comments)
 * - Consistency (minimum games/trades threshold)
 *
 * **Features:**
 * - Ranked by reputation score (highest first)
 * - Minimum games filter (ensures active players)
 * - Configurable result limit
 * - Includes user metadata
 * - Real-time score calculation
 *
 * @openapi
 * /api/reputation/leaderboard:
 *   get:
 *     tags:
 *       - Reputation
 *     summary: Get reputation leaderboard
 *     description: Returns ranked list of top performers by reputation score
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 100
 *         description: Number of results to return
 *       - in: query
 *         name: minGames
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 5
 *         description: Minimum games/trades threshold
 *       - in: query
 *         name: timeRange
 *         schema:
 *           type: string
 *           enum: [all, daily, weekly, monthly]
 *           default: all
 *         description: Filter leaderboard entries by recent activity window
 *     responses:
 *       200:
 *         description: Reputation leaderboard
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       rank:
 *                         type: integer
 *                       userId:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       reputationScore:
 *                         type: number
 *                       gamesPlayed:
 *                         type: integer
 *                       accuracy:
 *                         type: number
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     minGames:
 *                       type: integer
 *                     timeRange:
 *                       type: string
 *
 * @example
 * ```typescript
 * // Get top 50 by reputation
 * const response = await fetch('/api/reputation/leaderboard?limit=50');
 * const { leaderboard, metadata } = await response.json();
 *
 * // Get highly active users only
 * const activeUsers = await fetch('/api/reputation/leaderboard?minGames=20&limit=25');
 *
 * // Display leaderboard
 * leaderboard.forEach((entry, index) => {
 *   console.log(`#${entry.rank}: ${entry.displayName}`);
 *   console.log(`  Score: ${entry.reputationScore.toFixed(2)}`);
 *   console.log(`  Accuracy: ${(entry.accuracy * 100).toFixed(1)}%`);
 * });
 * ```
 *
 * @see {@link /lib/reputation/reputation-service} Reputation calculation
 * @see {@link /src/app/reputation/page.tsx} Reputation UI
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  withErrorHandling,
} from "@feed/api";
import { getReputationLeaderboard } from "@feed/engine";
import { toISOOrNull } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getReputationActivityCutoff,
  parseReputationLeaderboardQuery,
} from "./query";

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const { limit, minGames, timeRange } =
    parseReputationLeaderboardQuery(searchParams);
  const activeSince = getReputationActivityCutoff(timeRange);
  const leaderboard = await getReputationLeaderboard(limit, minGames, {
    activeSince,
  });

  const res = NextResponse.json({
    success: true,
    leaderboard,
    metadata: {
      count: leaderboard.length,
      limit,
      minGames,
      timeRange,
      activitySince: toISOOrNull(activeSince),
    },
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
