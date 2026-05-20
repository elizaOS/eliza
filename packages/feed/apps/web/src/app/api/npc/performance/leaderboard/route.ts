/**
 * NPC Performance Leaderboard API
 *
 * @route GET /api/npc/performance/leaderboard - Get NPC leaderboard
 * @access Public
 *
 * @description
 * Returns ranked list of NPC actors by portfolio performance. Includes
 * filtering options for minimum portfolio value and result limit.
 *
 * @openapi
 * /api/npc/performance/leaderboard:
 *   get:
 *     tags:
 *       - NPC
 *     summary: Get NPC performance leaderboard
 *     description: Returns ranked NPC actors by portfolio performance
 *     parameters:
 *       - in: query
 *         name: minValue
 *         schema:
 *           type: number
 *         description: Minimum portfolio value filter
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum results to return (capped at 100)
 *     responses:
 *       200:
 *         description: Leaderboard retrieved successfully
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
 *                       actorId:
 *                         type: string
 *                       actorName:
 *                         type: string
 *                       personality:
 *                         type: string
 *                         nullable: true
 *                       profileImageUrl:
 *                         type: string
 *                         nullable: true
 *                       poolId:
 *                         type: string
 *                       performance:
 *                         type: object
 *                         properties:
 *                           totalValue:
 *                             type: number
 *                           roi:
 *                             type: number
 *                           realizedPnL:
 *                             type: number
 *                           unrealizedPnL:
 *                             type: number
 *                           positionCount:
 *                             type: integer
 *                           utilization:
 *                             type: number
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     minValue:
 *                       type: number
 *
 * @example
 * ```typescript
 * const { leaderboard } = await fetch('/api/npc/performance/leaderboard?limit=10')
 *   .then(r => r.json());
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  withErrorHandling,
} from '@babylon/api';
import {
  actorState,
  db,
  eq,
  inArray,
  perpPositions,
  poolPositions,
  pools,
} from '@babylon/db';
import {
  buildFallbackMetricsByPool,
  NPCInvestmentManager,
  type PoolMetrics,
  StaticDataRegistry,
} from '@babylon/engine';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const parseLimit = (raw: string | null) => {
  if (!raw) return 50;
  const parsed = Number.parseInt(raw, 10);
  return Math.min(Number.isNaN(parsed) ? 50 : parsed, 100);
};

const parseMinValue = (raw: string | null) => {
  if (!raw) return 0;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);

  const limitParam = searchParams.get('limit');
  const minValueParam = searchParams.get('minValue');

  const limit = parseLimit(limitParam);
  const minValue = parseMinValue(minValueParam);

  const activePools = await db
    .select()
    .from(pools)
    .where(eq(pools.isActive, true));

  const activePoolIds = activePools.map((pool) => pool.id);

  // Fetch fallback data lazily so we can serve metrics even when
  // getPortfolioMetrics() throws (e.g. missing actorState rows).
  let fallbackMetricsByPool: Map<string, PoolMetrics> | null = null;
  let fallbackMetricsPromise: Promise<Map<string, PoolMetrics>> | null = null;

  const loadFallbackMetrics = async () => {
    if (fallbackMetricsByPool) return fallbackMetricsByPool;
    if (fallbackMetricsPromise) return fallbackMetricsPromise;

    fallbackMetricsPromise = (async () => {
      if (activePoolIds.length === 0) {
        fallbackMetricsByPool = new Map();
        return fallbackMetricsByPool;
      }

      const [balances, positionRows, perpRows] = await Promise.all([
        db
          .select({
            id: actorState.id,
            tradingBalance: actorState.tradingBalance,
          })
          .from(actorState)
          .where(inArray(actorState.id, activePoolIds)),
        db
          .select({
            id: poolPositions.id,
            poolId: poolPositions.poolId,
            marketType: poolPositions.marketType,
            size: poolPositions.size,
            leverage: poolPositions.leverage,
            unrealizedPnL: poolPositions.unrealizedPnL,
            realizedPnL: poolPositions.realizedPnL,
            closedAt: poolPositions.closedAt,
          })
          .from(poolPositions)
          .where(inArray(poolPositions.poolId, activePoolIds)),
        db
          .select({
            id: perpPositions.id,
            userId: perpPositions.userId,
            size: perpPositions.size,
            leverage: perpPositions.leverage,
            unrealizedPnL: perpPositions.unrealizedPnL,
            realizedPnL: perpPositions.realizedPnL,
            closedAt: perpPositions.closedAt,
          })
          .from(perpPositions)
          .where(inArray(perpPositions.userId, activePoolIds)),
      ]);

      fallbackMetricsByPool = buildFallbackMetricsByPool(
        activePools,
        balances,
        positionRows,
        perpRows
      );
      return fallbackMetricsByPool;
    })();

    try {
      return await fallbackMetricsPromise;
    } finally {
      fallbackMetricsPromise = null;
    }
  };

  const leaderboardRows = await Promise.all(
    activePools.map(async (pool) => {
      try {
        const metrics = await NPCInvestmentManager.getPortfolioMetrics(pool.id);
        return { pool, metrics };
      } catch (error) {
        const fallback = (await loadFallbackMetrics()).get(pool.id);
        if (!fallback) {
          logger.warn('Skipping NPC performance row due to metrics failure', {
            poolId: pool.id,
            actorId: pool.npcActorId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }

        logger.warn('Using batched fallback NPC performance metrics', {
          poolId: pool.id,
          actorId: pool.npcActorId,
          error: error instanceof Error ? error.message : String(error),
        });

        return { pool, metrics: fallback };
      }
    })
  );

  const leaderboard = leaderboardRows
    .filter(
      (row): row is NonNullable<(typeof leaderboardRows)[number]> =>
        row !== null && row.metrics.totalValue >= minValue
    )
    .sort((a, b) => b.metrics.totalValue - a.metrics.totalValue)
    .slice(0, limit)
    .map(({ pool, metrics }, index) => {
      const initialValue = Number.parseFloat(
        pool.totalDeposits?.toString() || '0'
      );
      const roi =
        initialValue > 0
          ? ((metrics.totalValue - initialValue) / initialValue) * 100
          : 0;
      const actor = StaticDataRegistry.getActor(pool.npcActorId);

      return {
        rank: index + 1,
        actorId: actor?.id || pool.npcActorId,
        actorName: actor?.name || 'Unknown',
        personality: actor?.personality || null,
        profileImageUrl: actor?.profileImageUrl || null,
        poolId: pool.id,
        performance: {
          totalValue: Math.round(metrics.totalValue),
          roi: Number.parseFloat(roi.toFixed(2)),
          realizedPnL: Math.round(metrics.realizedPnL),
          unrealizedPnL: Math.round(metrics.unrealizedPnL),
          positionCount: metrics.positionCount,
          utilization: Number.parseFloat(metrics.utilization.toFixed(1)),
        },
      };
    });

  const res = NextResponse.json({
    success: true,
    leaderboard,
    metadata: {
      count: leaderboard.length,
      limit,
      minValue,
    },
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
