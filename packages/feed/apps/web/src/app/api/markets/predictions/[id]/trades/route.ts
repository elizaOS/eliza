// GET /api/markets/predictions/[id]/trades – paginated trades for a market
import type { JsonValue } from '@babylon/api';
import {
  addPublicReadHeaders,
  getCache,
  publicRateLimit,
  setCache,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { db, eq, inArray, markets, sql, users } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

type PredictionTradeRow = {
  id: string;
  type: 'balance' | 'npc';
  userId: string;
  transactionType: string | null;
  amount: number | string;
  marketId: string | null;
  marketType: string | null;
  ticker: string | null;
  action: string | null;
  side: string | null;
  price: number | string | null;
  sentiment: number | string | null;
  reason: string | null;
  timestampMs: number | string | bigint;
};

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { id: marketId } = await context.params;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const queryParams = QuerySchema.parse({
      limit: searchParams.get('limit') || '20',
      offset: searchParams.get('offset') || '0',
    });

    logger.info(
      'Prediction market trades requested',
      { marketId, queryParams },
      'GET /api/markets/predictions/[id]/trades'
    );

    // Check Redis cache first
    const cacheKey = `prediction-trades:v2:${marketId}:${queryParams.limit}:${queryParams.offset}`;
    const cached = await getCache<Record<string, JsonValue>>(cacheKey);

    if (cached) {
      return successResponse(cached);
    }

    // Verify market exists (drizzle) - used for response metadata
    const [market] = await db
      .select({
        id: markets.id,
        question: markets.question,
      })
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);

    if (!market) {
      return successResponse({ error: 'Market not found' }, 404);
    }

    const limitPlusOne = queryParams.limit + 1;

    // Merge balance (user/agent) trades and NPC trades into a single time-sorted feed.
    // Use epoch-millis to avoid timezone ambiguity with timestamp (no tz) columns.
    const tradeRows = (await db.execute(sql`
      select
        bt."id" as "id",
        'balance' as "type",
        bt."userId" as "userId",
        bt."type" as "transactionType",
        bt."amount"::float8 as "amount",
        bt."relatedId" as "marketId",
        null::text as "marketType",
        null::text as "ticker",
        null::text as "action",
        null::text as "side",
        null::float8 as "price",
        null::float8 as "sentiment",
        null::text as "reason",
        (extract(epoch from bt."createdAt") * 1000)::bigint as "timestampMs"
      from "BalanceTransaction" bt
      where bt."relatedId" = ${marketId}
        and bt."type" in ('pred_buy', 'pred_sell')

      union all

      select
        nt."id" as "id",
        'npc' as "type",
        nt."npcActorId" as "userId",
        null::text as "transactionType",
        nt."amount"::float8 as "amount",
        nt."marketId" as "marketId",
        nt."marketType" as "marketType",
        nt."ticker" as "ticker",
        nt."action" as "action",
        nt."side" as "side",
        nt."price"::float8 as "price",
        nt."sentiment"::float8 as "sentiment",
        nt."reason" as "reason",
        (extract(epoch from nt."executedAt") * 1000)::bigint as "timestampMs"
      from "NPCTrade" nt
      where nt."marketType" = 'prediction'
        and nt."marketId" = ${marketId}

      order by "timestampMs" desc
      limit ${limitPlusOne}
      offset ${queryParams.offset}
    `)) as PredictionTradeRow[];

    const hasMore = tradeRows.length > queryParams.limit;
    const pageRows = hasMore
      ? tradeRows.slice(0, queryParams.limit)
      : tradeRows;

    const userIds = [
      ...new Set(pageRows.map((row) => row.userId).filter(Boolean)),
    ] as string[];
    const userRows =
      userIds.length > 0
        ? await db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              profileImageUrl: users.profileImageUrl,
              isActor: users.isActor,
            })
            .from(users)
            .where(inArray(users.id, userIds))
        : [];
    const userMap = new Map(userRows.map((u) => [u.id, u]));

    const trades = pageRows.map((row) => {
      const timestamp = new Date(Number(row.timestampMs)).toISOString();
      if (row.type === 'balance') {
        return {
          id: row.id,
          type: 'balance' as const,
          user: userMap.get(row.userId) ?? null,
          transactionType: row.transactionType,
          amount: Number(row.amount),
          timestamp,
          marketId,
        };
      }

      return {
        id: row.id,
        type: 'npc' as const,
        user: userMap.get(row.userId) ?? null,
        marketType: row.marketType ?? 'prediction',
        ticker: row.ticker ?? '',
        action: row.action ?? 'unknown',
        side: row.side ?? null,
        amount: Number(row.amount),
        price: Number(row.price ?? 0),
        sentiment: row.sentiment != null ? Number(row.sentiment) : null,
        reason: row.reason ?? null,
        timestamp,
      };
    });

    const result = {
      trades,
      total: queryParams.offset + trades.length + (hasMore ? 1 : 0),
      hasMore,
      marketId: market.id,
      question: market.question,
    };

    // Cache briefly; feed is also updated via SSE.
    await setCache(cacheKey, result, { ttl: 10, namespace: 'market-trades' });

    const res = successResponse(result);
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }
);
