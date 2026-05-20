/**
 * NPC Reputation-Adjusted Allocation API
 *
 * @route POST /api/npc/allocation - Calculate reputation-adjusted allocation
 * @access Public
 *
 * @description
 * Calculates allocation amount adjusted by NPC's reputation score. Returns
 * adjusted amount, reputation score, multiplier, and whether fallback was used.
 *
 * @openapi
 * /api/npc/allocation:
 *   post:
 *     tags:
 *       - NPC
 *     summary: Calculate reputation-adjusted allocation
 *     description: Calculates allocation adjusted by NPC reputation score
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - npcUserId
 *               - baseAmount
 *             properties:
 *               npcUserId:
 *                 type: string
 *               baseAmount:
 *                 type: number
 *                 description: Base allocation amount
 *     responses:
 *       200:
 *         description: Allocation calculated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 adjustedAmount:
 *                   type: number
 *                 reputationScore:
 *                   type: number
 *                 multiplier:
 *                   type: number
 *                 usedFallback:
 *                   type: boolean
 *       400:
 *         description: Invalid input
 *
 * @example
 * ```typescript
 * const { adjustedAmount } = await fetch('/api/npc/allocation', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     npcUserId: 'npc-id',
 *     baseAmount: 1000
 *   })
 * }).then(r => r.json());
 * ```
 */

import { requireCronAuth, withErrorHandling } from '@feed/api';
import { getReputationBreakdown, NPCInvestmentManager } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const AllocationRequestSchema = z.object({
  npcUserId: z.string().min(1),
  baseAmount: z.number().positive(),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  requireCronAuth(request, { jobName: 'NPCAllocation' });

  const body = AllocationRequestSchema.parse(await request.json());

  const adjustedAmount =
    await NPCInvestmentManager.calculateReputationAdjustedAllocation(
      body.npcUserId,
      body.baseAmount
    );

  const reputation = await getReputationBreakdown(body.npcUserId);
  const reputationScore = reputation?.reputationScore ?? 50;
  const multiplier = adjustedAmount / body.baseAmount;
  const usedFallback = reputation == null;

  if (usedFallback) {
    logger.warn(
      `Could not retrieve reputation for ${body.npcUserId}`,
      undefined,
      'NPCAllocation'
    );
  }

  logger.info('Reputation-adjusted allocation calculated', {
    npcUserId: body.npcUserId,
    baseAmount: body.baseAmount,
    adjustedAmount,
    reputationScore,
    multiplier,
  });

  return NextResponse.json({
    success: true,
    adjustedAmount,
    baseAmount: body.baseAmount,
    reputationScore,
    multiplier,
    usedFallback,
  });
});
