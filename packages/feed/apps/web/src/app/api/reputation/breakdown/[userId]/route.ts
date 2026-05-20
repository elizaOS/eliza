/**
 * Reputation Breakdown API
 *
 * @route GET /api/reputation/breakdown/[userId] - Get detailed reputation breakdown
 * @access Public
 *
 * @description
 * Returns detailed breakdown of reputation score components including PNL component
 * (40% weight), feedback component (40% weight), activity component (20% weight),
 * raw metrics, and confidence scores.
 *
 * @openapi
 * /api/reputation/breakdown/{userId}:
 *   get:
 *     tags:
 *       - Reputation
 *     summary: Get reputation breakdown
 *     description: Returns detailed breakdown of reputation score components and weights
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID, username, or wallet address
 *     responses:
 *       200:
 *         description: Reputation breakdown retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 userId:
 *                   type: string
 *                 reputationScore:
 *                   type: number
 *                 trustLevel:
 *                   type: string
 *                 confidenceScore:
 *                   type: number
 *                 breakdown:
 *                   type: object
 *                   properties:
 *                     pnl:
 *                       type: number
 *                     feedback:
 *                       type: number
 *                     activity:
 *                       type: number
 *                 metrics:
 *                   type: object
 *                 weights:
 *                   type: object
 *                   properties:
 *                     pnl:
 *                       type: number
 *                       example: 0.4
 *                     feedback:
 *                       type: number
 *                       example: 0.4
 *                     activity:
 *                       type: number
 *                       example: 0.2
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/reputation/breakdown/user_123');
 * const { breakdown, weights } = await response.json();
 * console.log(`PNL: ${breakdown.pnl} (${weights.pnl * 100}% weight)`);
 * ```
 *
 * @see {@link /lib/reputation/reputation-service} Reputation service
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  requireUserByIdentifier,
  withErrorHandling,
} from '@babylon/api';
import { getReputationBreakdown } from '@babylon/engine';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface RouteParams {
  params: Promise<{
    userId: string;
  }>;
}

export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { userId } = await params;

  const user = await requireUserByIdentifier(userId);

  const breakdown = await getReputationBreakdown(user.id);

  const res = NextResponse.json({
    success: true,
    userId: user.id,
    reputationScore: breakdown!.reputationScore,
    trustLevel: breakdown!.trustLevel,
    confidenceScore: breakdown!.confidenceScore,
    breakdown: breakdown!.breakdown,
    metrics: breakdown!.metrics,
    weights: {
      pnl: 0.4,
      feedback: 0.4,
      activity: 0.2,
    },
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
