/**
 * Admin Markets Oversight API
 *
 * @route GET /api/admin/markets - Get market overview and stats
 * @access Admin
 *
 * @description
 * Returns market statistics and list of active/recent markets
 * for admin oversight and management.
 */

import { requireAdmin, successResponse, withErrorHandling } from '@babylon/api';
import { PredictionPricing } from '@babylon/core/markets/prediction/pricing';
import {
  and,
  count,
  db,
  desc,
  eq,
  gte,
  lte,
  markets,
  positions,
  sql,
} from '@babylon/db';
import { logger, toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'all'; // 'all', 'active', 'resolved', 'expired'
  // Clamp limit to prevent heavy queries (min 1, max 200, default 50)
  const rawLimit = parseInt(searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 200);

  logger.info(
    'Admin markets overview requested',
    { status, limit },
    'GET /api/admin/markets'
  );

  const now = new Date();
  // Convert to ISO string for proper PostgreSQL timestamp comparison
  const nowIso = toISO(now);

  // Get market statistics
  // Note: Raw SQL aggregations use parameterized now value; query builder filters use Date directly
  const [marketStats] = await db
    .select({
      total: count(),
      active: sql<number>`COUNT(*) FILTER (WHERE ${markets.resolved} = false AND ${markets.endDate} > ${nowIso}::timestamp)`,
      expired: sql<number>`COUNT(*) FILTER (WHERE ${markets.resolved} = false AND ${markets.endDate} <= ${nowIso}::timestamp)`,
      resolved: sql<number>`COUNT(*) FILTER (WHERE ${markets.resolved} = true)`,
      totalLiquidity: sql<number>`COALESCE(SUM(${markets.liquidity}::numeric), 0)`,
    })
    .from(markets);

  // Get position statistics
  const [positionStats] = await db
    .select({
      totalPositions: count(),
      activePositions: sql<number>`COUNT(*) FILTER (WHERE ${positions.status} = 'active')`,
      totalValue: sql<number>`COALESCE(SUM(${positions.amount}::numeric), 0)`,
    })
    .from(positions);

  // Build filter for markets list
  let statusFilter = undefined;
  if (status === 'active') {
    statusFilter = and(eq(markets.resolved, false), gte(markets.endDate, now));
  } else if (status === 'expired') {
    statusFilter = and(eq(markets.resolved, false), lte(markets.endDate, now));
  } else if (status === 'resolved') {
    statusFilter = eq(markets.resolved, true);
  }

  // Get markets list with statistics
  const marketsList = await db
    .select({
      id: markets.id,
      question: markets.question,
      description: markets.description,
      yesShares: markets.yesShares,
      noShares: markets.noShares,
      liquidity: markets.liquidity,
      resolved: markets.resolved,
      resolution: markets.resolution,
      endDate: markets.endDate,
      createdAt: markets.createdAt,
      positionCount: sql<number>`(
        SELECT COUNT(*) FROM "Position" 
        WHERE "Position"."marketId" = ${markets.id}
      )`,
      tradeCount: sql<number>`0`,
      totalVolume: sql<number>`0`,
    })
    .from(markets)
    .where(statusFilter)
    .orderBy(desc(markets.createdAt))
    .limit(limit);

  // Calculate yes price for each market using the canonical CPMM pricing formula
  // from PredictionPricing.getCurrentPrice: yesPrice = noShares / (yesShares + noShares)
  const marketsWithPrices = marketsList.map((market) => {
    const yesShares = parseFloat(String(market.yesShares));
    const noShares = parseFloat(String(market.noShares));
    const yesPrice = PredictionPricing.getCurrentPrice(
      yesShares,
      noShares,
      'yes'
    );
    const noPrice = PredictionPricing.getCurrentPrice(
      yesShares,
      noShares,
      'no'
    );

    return {
      ...market,
      yesPrice: Math.round(yesPrice * 100),
      noPrice: Math.round(noPrice * 100),
      status: market.resolved
        ? 'resolved'
        : new Date(market.endDate) <= now
          ? 'expired'
          : 'active',
    };
  });

  return successResponse({
    stats: {
      total: marketStats?.total ?? 0,
      active: Number(marketStats?.active ?? 0),
      expired: Number(marketStats?.expired ?? 0),
      resolved: Number(marketStats?.resolved ?? 0),
      totalLiquidity: Number(marketStats?.totalLiquidity ?? 0),
      totalPositions: positionStats?.totalPositions ?? 0,
      activePositions: Number(positionStats?.activePositions ?? 0),
      totalPositionValue: Number(positionStats?.totalValue ?? 0),
    },
    markets: marketsWithPrices,
  });
});
