/**
 * NPC Portfolio API
 *
 * @route GET /api/npc/[actorId]/portfolio - Get NPC portfolio
 * @access Public
 *
 * @description
 * Returns comprehensive portfolio data for an NPC actor including total
 * portfolio value, PnL, position count, and risk metrics.
 *
 * @openapi
 * /api/npc/{actorId}/portfolio:
 *   get:
 *     tags:
 *       - NPC
 *     summary: Get NPC portfolio
 *     description: Returns comprehensive portfolio data for NPC actor
 *     parameters:
 *       - in: path
 *         name: actorId
 *         required: true
 *         schema:
 *           type: string
 *         description: NPC actor ID
 *     responses:
 *       200:
 *         description: Portfolio retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalValue:
 *                   type: number
 *                 unrealizedPnl:
 *                   type: number
 *                 realizedPnl:
 *                   type: number
 *                 positionCount:
 *                   type: integer
 *                 riskScore:
 *                   type: number
 *       404:
 *         description: NPC actor not found
 *
 * @example
 * ```typescript
 * const portfolio = await fetch(`/api/npc/${actorId}/portfolio`)
 *   .then(r => r.json());
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  requireUserByIdentifier,
  withErrorHandling,
} from "@feed/api";
import { db } from "@feed/db";
import { NPCInvestmentManager } from "@feed/engine";
import { toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

interface RouteParams {
  params: Promise<{
    actorId: string;
  }>;
}

export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  { params }: RouteParams,
) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { actorId } = await params;

  const actor = await requireUserByIdentifier(actorId);

  const pool = await db.pool.findFirst({
    where: {
      npcActorId: actor.id,
      isActive: true,
    },
  });

  if (!pool) {
    return NextResponse.json(
      { error: "No active pool found for actor" },
      { status: 404 },
    );
  }

  const metrics = await NPCInvestmentManager.getPortfolioMetrics(pool.id);

  const positions = await db.poolPosition.findMany({
    where: {
      poolId: pool.id,
      closedAt: null,
    },
    select: {
      id: true,
      marketType: true,
      ticker: true,
      marketId: true,
      side: true,
      size: true,
      entryPrice: true,
      currentPrice: true,
      unrealizedPnL: true,
      leverage: true,
      openedAt: true,
    },
    orderBy: {
      openedAt: "desc",
    },
  });

  const formattedPositions = positions.map((pos) => ({
    id: pos.id,
    marketType: pos.marketType,
    ticker: pos.ticker,
    marketId: pos.marketId,
    side: pos.side,
    size: Number.parseFloat(pos.size?.toString()),
    entryPrice: Number.parseFloat(pos.entryPrice?.toString()),
    currentPrice: Number.parseFloat(pos.currentPrice?.toString()),
    unrealizedPnL: Number.parseFloat(pos.unrealizedPnL?.toString()),
    leverage: pos.leverage,
    createdAt: toISO(pos.openedAt),
  }));

  const res = NextResponse.json({
    success: true,
    actorId: actor.id,
    actorName: actor.displayName!,
    poolId: pool.id,
    portfolio: {
      totalValue: metrics.totalValue,
      availableBalance: metrics.availableBalance,
      unrealizedPnL: metrics.unrealizedPnL,
      realizedPnL: metrics.realizedPnL,
      positionCount: metrics.positionCount,
      utilization: metrics.utilization,
      riskScore: metrics.riskScore,
    },
    positions: formattedPositions,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
