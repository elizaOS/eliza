/**
 * NPC Position Size Recommendation API
 *
 * @route GET /api/npc/position-size - Get position size recommendation
 * @access Public
 *
 * @description
 * Calculates recommended position size based on portfolio metrics, strategy,
 * and reputation. Returns position size as decimal (0.10 = 10%).
 *
 * @openapi
 * /api/npc/position-size:
 *   get:
 *     tags:
 *       - NPC
 *     summary: Get position size recommendation
 *     description: Calculates recommended position size for NPC
 *     parameters:
 *       - in: query
 *         name: npcUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: NPC user ID
 *       - in: query
 *         name: poolId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *       - in: query
 *         name: strategy
 *         schema:
 *           type: string
 *           enum: [aggressive, conservative, balanced]
 *         description: Investment strategy
 *     responses:
 *       200:
 *         description: Recommendation retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 positionSize:
 *                   type: number
 *                   description: Recommended size as decimal (0.10 = 10%)
 *                 riskAdjusted:
 *                   type: boolean
 *                 reputationBoost:
 *                   type: boolean
 *                 portfolioMetrics:
 *                   type: object
 *       400:
 *         description: Invalid query parameters
 *
 * @example
 * ```typescript
 * const { positionSize } = await fetch('/api/npc/position-size?npcUserId=id&poolId=pool&strategy=balanced')
 *   .then(r => r.json());
 * ```
 */

import { verifyCronAuth, withErrorHandling } from "@feed/api";
import { getReputationBreakdown, NPCInvestmentManager } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const PositionSizeQuerySchema = z.object({
  npcUserId: z.string().min(1),
  poolId: z.string().min(1),
  strategy: z
    .enum(["aggressive", "conservative", "balanced"])
    .default("balanced"),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  if (!verifyCronAuth(request, { jobName: "NPCPositionSize" })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const { npcUserId, poolId, strategy } = PositionSizeQuerySchema.parse({
    npcUserId: searchParams.get("npcUserId") ?? undefined,
    poolId: searchParams.get("poolId") ?? undefined,
    strategy: searchParams.get("strategy") ?? undefined,
  });

  const positionSize = await NPCInvestmentManager.getRecommendedPositionSize(
    poolId,
    npcUserId,
    strategy,
  );

  const metrics = await NPCInvestmentManager.getPortfolioMetrics(poolId);

  const riskAdjusted = metrics.riskScore > 0.6 || metrics.utilization > 70;

  const reputation = await getReputationBreakdown(npcUserId);
  const reputationBoost = (reputation?.reputationScore ?? 0) >= 70;

  if (!reputation) {
    logger.debug(
      "Could not check reputation for position size",
      undefined,
      "NPCPositionSize",
    );
  }

  logger.info("Position size calculated", {
    npcUserId,
    poolId,
    strategy,
    positionSize,
    riskAdjusted,
    reputationBoost,
  });

  return NextResponse.json({
    success: true,
    positionSize,
    strategy,
    riskAdjusted,
    reputationBoost,
    portfolioMetrics: {
      utilization: metrics.utilization,
      riskScore: metrics.riskScore,
      positionCount: metrics.positionCount,
      unrealizedPnL: metrics.unrealizedPnL,
    },
  });
});
