/**
 * Market Dynamics API
 *
 * @route GET /api/questions/[id]/dynamics - Get market dynamics
 * @access Public
 *
 * @description
 * Returns PUBLIC market data including prices, volumes, and momentum.
 * Safe for competitive MMO - all observable information. NO oracle data exposed.
 *
 * @openapi
 * /api/questions/{id}/dynamics:
 *   get:
 *     tags:
 *       - Markets
 *     summary: Get market dynamics
 *     description: Returns public market data (prices, volumes, momentum)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Question/market ID
 *     responses:
 *       200:
 *         description: Dynamics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 price:
 *                   type: number
 *                 volume:
 *                   type: number
 *                 momentum:
 *                   type: number
 *       404:
 *         description: Market not found
 *
 * @example
 * ```typescript
 * const dynamics = await fetch(`/api/questions/${questionId}/dynamics`)
 *   .then(r => r.json());
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  withErrorHandling,
} from '@babylon/api';
import { PredictionPricing } from '@babylon/core/markets/prediction';
import { db } from '@babylon/db';
import { toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { id } = await params;
  const questionNumber = Number.parseInt(id);

  // Get question and market:
  const question = await db.question.findUnique({
    where: { questionNumber },
  });

  if (!question) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 });
  }

  const market = await db.market.findUnique({
    where: { id: question.id },
  });

  if (!market) {
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  }

  // Get positions for volume analysis (public data):
  const positions = await db.position.findMany({
    where: {
      marketId: market.id,
    },
    orderBy: { createdAt: 'asc' },
    take: 1000, // Last 1000 positions
  });

  // Build price history from positions (grouped by creation time)
  // Each position represents a trade at a specific price point
  const priceHistory: Array<{
    timestamp: string;
    yesPrice: number;
    noPrice: number;
    volume: number;
  }> = [];

  // Group positions by time buckets (hourly) to build price history
  const positionGroups = new Map<string, typeof positions>();
  for (const pos of positions) {
    // Use createdAt for when the position was opened (trade executed)
    const hourKey = new Date(pos.createdAt).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    if (!positionGroups.has(hourKey)) {
      positionGroups.set(hourKey, []);
    }
    positionGroups.get(hourKey)!.push(pos);
  }

  // Calculate price for each time bucket based on positions
  for (const [hourKey, hourPositions] of positionGroups.entries()) {
    let yesShares = 0;
    let noShares = 0;
    let volume = 0;

    for (const pos of hourPositions) {
      const shares = Number(pos.shares);
      const price = Number(pos.avgPrice);
      volume += shares * price;

      if (pos.side) {
        yesShares += shares;
      } else {
        noShares += shares;
      }
    }

    const totalShares = yesShares + noShares;
    const yesPrice =
      totalShares > 0
        ? PredictionPricing.getCurrentPrice(yesShares, noShares, 'yes')
        : 0.5;
    const noPrice = 1 - yesPrice;

    priceHistory.push({
      timestamp: `${hourKey}:00:00Z`,
      yesPrice,
      noPrice,
      volume,
    });
  }

  // Sort by timestamp
  priceHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Current prices:
  const yesShares = Number(market.yesShares);
  const noShares = Number(market.noShares);
  const totalShares = yesShares + noShares;

  const currentYesPrice =
    totalShares > 0
      ? PredictionPricing.getCurrentPrice(yesShares, noShares, 'yes')
      : 0.5;

  // Calculate total volume from positions:
  const totalVolume = positions.reduce((sum, p) => {
    return sum + Number(p.shares) * Number(p.avgPrice);
  }, 0);

  // Simple momentum (price away from 0.5):
  const priceMomentum = currentYesPrice - 0.5;

  // Find largest positions (whale watching):
  const largestPositions = positions
    .sort((a, b) => {
      const aSize = Number(a.shares) * Number(a.avgPrice);
      const bSize = Number(b.shares) * Number(b.avgPrice);
      return bSize - aSize;
    })
    .slice(0, 10)
    .map((p) => ({
      side: p.side ? 'YES' : 'NO',
      shares: Number(p.shares),
      avgPrice: Number(p.avgPrice),
      value: Number(p.shares) * Number(p.avgPrice),
      timestamp: toISO(p.createdAt),
    }));

  const res = NextResponse.json({
    questionId: questionNumber,
    questionText: question.text,
    status: question.status,

    // Current state (PUBLIC):
    currentPrice: {
      yes: Number(currentYesPrice.toFixed(4)),
      no: Number((1 - currentYesPrice).toFixed(4)),
    },

    // Market dynamics (PUBLIC):
    totalVolume: Number(totalVolume.toFixed(2)),
    totalPositions: positions.length,

    // Momentum indicators (PUBLIC):
    momentum:
      priceMomentum > 0.05
        ? 'strong_yes'
        : priceMomentum < -0.05
          ? 'strong_no'
          : Math.abs(priceMomentum) > 0.02
            ? 'moderate'
            : 'stable',
    priceChange: Number(priceMomentum.toFixed(4)),

    // Volume trend (PUBLIC):
    volumeTrend:
      totalVolume > 10000 ? 'high' : totalVolume > 1000 ? 'medium' : 'low',

    // Conviction indicator (PUBLIC):
    conviction:
      totalVolume > 10000 && Math.abs(priceMomentum) > 0.05
        ? 'high'
        : totalVolume > 1000 || Math.abs(priceMomentum) > 0.03
          ? 'medium'
          : 'low',

    // Price history (PUBLIC):
    priceHistory: priceHistory.slice(-100), // Last 100 data points (empty for now)

    // Whale watching (PUBLIC):
    largestPositions,

    // NO ORACLE DATA:
    // outcome: undefined,  ❌ Not included
    // clueStrength: undefined,  ❌ Not included
    // pointsToward: undefined  ❌ Not included
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
