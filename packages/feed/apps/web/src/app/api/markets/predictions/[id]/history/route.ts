import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { and, db, desc, eq, gte, predictionPriceHistories } from '@feed/db';
import { PredictionMarketIdSchema, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { chooseBucketMs } from '@/lib/api/chart-utils';

type TimeRange = '1H' | '4H' | '1D' | '1W' | 'ALL';

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

function downsamplePredictionHistory(
  points: Array<{
    id: string;
    yesPrice: number;
    noPrice: number;
    yesShares: number;
    noShares: number;
    liquidity: number;
    eventType: string;
    source: string;
    createdAt: Date;
  }>,
  maxPoints: number
): Array<{
  id: string;
  yesPrice: number;
  noPrice: number;
  yesShares: number;
  noShares: number;
  liquidity: number;
  eventType: string;
  source: string;
  createdAt: Date;
}> {
  if (points.length <= maxPoints) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];

  const spanMs = last.createdAt.getTime() - first.createdAt.getTime();
  const bucketMs = chooseBucketMs(spanMs, maxPoints);

  const buckets = new Map<number, (typeof points)[number]>();
  for (const point of points) {
    const t = point.createdAt.getTime();
    const bucketStart = Math.floor(t / bucketMs) * bucketMs;
    // Keep the most recent point in each bucket (points are expected ascending).
    buckets.set(bucketStart, point);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, point]) => ({
      ...point,
      createdAt: new Date(bucketStart),
    }));
}

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { id: marketId } = PredictionMarketIdSchema.parse(
      await context.params
    );
    const { searchParams } = new URL(request.url);
    const { limit, range } = QuerySchema.parse({
      limit: searchParams.get('limit'),
      range: searchParams.get('range'),
    });

    const now = new Date();
    const selectedRange = (range ?? 'ALL') as TimeRange;
    const since =
      selectedRange === 'ALL'
        ? null
        : new Date(now.getTime() - RANGE_MS[selectedRange]);

    const rawHistory = await db
      .select()
      .from(predictionPriceHistories)
      .where(
        since
          ? and(
              eq(predictionPriceHistories.marketId, marketId),
              gte(predictionPriceHistories.createdAt, since)
            )
          : eq(predictionPriceHistories.marketId, marketId)
      )
      .orderBy(desc(predictionPriceHistories.createdAt))
      .limit(range ? Math.max(limit * 10, 5000) : limit);

    const ascending = rawHistory.reverse().map((point) => ({
      ...point,
      yesPrice: Number(point.yesPrice),
      noPrice: Number(point.noPrice),
      yesShares: Number(point.yesShares),
      noShares: Number(point.noShares),
      liquidity: Number(point.liquidity),
    }));

    const history = range
      ? downsamplePredictionHistory(ascending, limit)
      : ascending;

    const res = successResponse({
      marketId,
      history: history.map((point) => ({
        id: point.id,
        yesPrice: point.yesPrice,
        noPrice: point.noPrice,
        yesShares: point.yesShares,
        noShares: point.noShares,
        liquidity: point.liquidity,
        eventType: point.eventType,
        source: point.source,
        timestamp: toISO(point.createdAt),
      })),
    });
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }
);
