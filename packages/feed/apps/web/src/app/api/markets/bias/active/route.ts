/**
 * Active Market Biases API
 *
 * @route GET /api/markets/bias/active - Get active market biases
 * @access Public
 *
 * @description
 * Returns list of all active market biases configured in the system. Shows
 * current sentiment/price manipulations affecting markets. Used for transparency
 * and market analysis.
 *
 * @openapi
 * /api/markets/bias/active:
 *   get:
 *     tags:
 *       - Markets
 *     summary: Get active market biases
 *     description: Returns all active market biases affecting prices and sentiment
 *     responses:
 *       200:
 *         description: Active biases retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 biases:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       entityId:
 *                         type: string
 *                       entityName:
 *                         type: string
 *                       direction:
 *                         type: string
 *                         enum: [up, down]
 *                       strength:
 *                         type: number
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       expiresAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       decayRate:
 *                         type: number
 *                       adjustment:
 *                         type: number
 *                 count:
 *                   type: integer
 *
 * @example
 * ```typescript
 * const { biases } = await fetch('/api/markets/bias/active')
 *   .then(r => r.json());
 * ```
 *
 * @see {@link /lib/feedback/bias-engine} Bias engine
 */

import { withErrorHandling } from '@babylon/api';
import { biasEngine } from '@babylon/engine';
import { toISO } from '@babylon/shared';
import { NextResponse } from 'next/server';

export const GET = withErrorHandling(async function GET() {
  // Get all active biases from the singleton engine
  const activeBiases = biasEngine.getActiveBiases();

  // Format biases for API response
  const biases = activeBiases.map((bias) => ({
    entityId: bias.entityId,
    entityName: bias.entityName,
    direction: bias.direction,
    strength: bias.strength,
    createdAt: toISO(bias.createdAt),
    expiresAt: bias.expiresAt ? toISO(bias.expiresAt) : null,
    decayRate: bias.decayRate,
    // Get current adjustment values
    adjustment: biasEngine.getBiasAdjustment(bias.entityId),
  }));

  return NextResponse.json({
    success: true,
    biases,
    count: biases.length,
  });
});
