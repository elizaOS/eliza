/**
 * Perpetual Market Price History API
 *
 * @route GET /api/markets/perps/[ticker]/history - Get price history
 * @access Public
 *
 * @description
 * Returns price history for a perpetual market including price, change,
 * and OHLCV data. Useful for charting and analytics.
 *
 * @openapi
 * /api/markets/perps/{ticker}/history:
 *   get:
 *     tags:
 *       - Markets
 *     summary: Get perpetual market price history
 *     description: Returns price history with OHLCV data for charting
 *     parameters:
 *       - in: path
 *         name: ticker
 *         required: true
 *         schema:
 *           type: string
 *         description: Market ticker symbol (e.g., AAPL, TSLA)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 2000
 *           default: 200
 *         description: Number of history points to return
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: [1H, 4H, 1D, 1W, ALL]
 *         description: Optional server-side time range filter/downsampling
 *     responses:
 *       200:
 *         description: Price history retrieved successfully
 *       404:
 *         description: Market not found
 *
 * @example
 * ```typescript
 * const response = await fetch(`/api/markets/perps/${ticker}/history?limit=100&range=1W`);
 * const { history } = await response.json();
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  and,
  db,
  desc,
  eq,
  gte,
  perpMarketSnapshots,
  stockPrices,
} from '@babylon/db';
import { toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { chooseBucketMs } from '@/lib/api/chart-utils';

type TimeRange = '1H' | '4H' | '1D' | '1W' | 'ALL';

const ParamsSchema = z.object({
  ticker: z.string().min(1).max(20),
});

const QuerySchema = z.object({
  limit: z
    .preprocess(
      (value) => (value === null ? undefined : value),
      z.coerce.number().min(1).max(2000)
    )
    .optional()
    .default(200),
  range: z.enum(['1H', '4H', '1D', '1W', 'ALL']).optional(),
});

const RANGE_MS: Record<TimeRange, number> = {
  '1H': 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
  ALL: 0,
};

function downsampleStockPrices(
  points: Array<{
    price: number;
    timestamp: Date;
    volume: number | null;
  }>,
  maxPoints: number
): Array<{
  price: number;
  timestamp: Date;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  change: number;
  changePercent: number;
}> {
  if (points.length <= maxPoints) {
    return points.map((p) => ({
      price: p.price,
      timestamp: p.timestamp,
      openPrice: p.price,
      highPrice: p.price,
      lowPrice: p.price,
      volume: Number(p.volume ?? 0),
      change: 0,
      changePercent: 0,
    }));
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];

  const spanMs = last.timestamp.getTime() - first.timestamp.getTime();
  const bucketMs = chooseBucketMs(spanMs, maxPoints);

  const buckets = new Map<
    number,
    {
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }
  >();

  for (const point of points) {
    const t = point.timestamp.getTime();
    const bucketStart = Math.floor(t / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart);
    const price = point.price;
    const volume = Number(point.volume ?? 0);

    if (!existing) {
      buckets.set(bucketStart, {
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
      });
      continue;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume += volume;
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, bucket]) => {
      const change = bucket.close - bucket.open;
      const changePercent =
        bucket.open === 0 ? 0 : (change / bucket.open) * 100;
      return {
        price: bucket.close,
        timestamp: new Date(bucketStart),
        openPrice: bucket.open,
        highPrice: bucket.high,
        lowPrice: bucket.low,
        volume: bucket.volume,
        change,
        changePercent,
      };
    });
}

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ ticker: string }> }
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { ticker } = ParamsSchema.parse(await context.params);
    const { searchParams } = new URL(request.url);
    const { limit, range } = QuerySchema.parse({
      limit: searchParams.get('limit'),
      range: searchParams.get('range'),
    });

    // Look up the organizationId from the perp market snapshot
    const [marketSnapshot] = await db
      .select({ organizationId: perpMarketSnapshots.organizationId })
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker))
      .limit(1);

    if (!marketSnapshot) {
      return successResponse({
        ticker,
        history: [],
        message: 'Market not found',
      });
    }

    const now = new Date();
    const selectedRange = (range ?? 'ALL') as TimeRange;
    const since =
      selectedRange === 'ALL'
        ? null
        : new Date(now.getTime() - RANGE_MS[selectedRange]);

    // Get price history from stockPrices table (raw points)
    const rawHistory = await db
      .select({
        id: stockPrices.id,
        price: stockPrices.price,
        change: stockPrices.change,
        changePercent: stockPrices.changePercent,
        timestamp: stockPrices.timestamp,
        openPrice: stockPrices.openPrice,
        highPrice: stockPrices.highPrice,
        lowPrice: stockPrices.lowPrice,
        volume: stockPrices.volume,
      })
      .from(stockPrices)
      .where(
        since
          ? and(
              eq(stockPrices.organizationId, marketSnapshot.organizationId),
              gte(stockPrices.timestamp, since)
            )
          : eq(stockPrices.organizationId, marketSnapshot.organizationId)
      )
      .orderBy(desc(stockPrices.timestamp))
      // When a range is selected, fetch more raw points so downsampling has enough signal.
      .limit(range ? Math.max(limit * 10, 5000) : limit);

    const ascending = rawHistory.reverse();
    const history = range
      ? downsampleStockPrices(
          ascending.map((p) => ({
            price: Number(p.price),
            timestamp: p.timestamp,
            volume: p.volume,
          })),
          limit
        ).map((p) => ({
          id: null as string | null,
          price: p.price,
          change: p.change,
          changePercent: p.changePercent,
          timestamp: p.timestamp,
          openPrice: p.openPrice,
          highPrice: p.highPrice,
          lowPrice: p.lowPrice,
          volume: p.volume,
        }))
      : ascending;

    const res = successResponse({
      ticker,
      organizationId: marketSnapshot.organizationId,
      history: history.map((point) => ({
        id: point.id ?? undefined,
        price: point.price,
        change: point.change,
        changePercent: point.changePercent,
        timestamp: toISO(point.timestamp),
        openPrice: point.openPrice,
        highPrice: point.highPrice,
        lowPrice: point.lowPrice,
        volume: point.volume,
      })),
    });
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }
);
