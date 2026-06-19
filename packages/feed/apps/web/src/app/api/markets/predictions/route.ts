import {
  addPublicReadHeaders,
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  PredictionDbAdapter,
  type PredictionMarketRecord,
  PredictionMarketService,
  type PredictionPositionRecord,
  PredictionPricing,
} from "@feed/core/markets/prediction";
import { FEE_CONFIG, WalletService } from "@feed/engine";
import { logger, MarketQuerySchema, toISOOrNull } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  buildPredictionUserPositionSnapshot,
  type PredictionUserPositionSnapshot,
} from "./_position-snapshot";

function buildUserPositionsRecord(
  positions: PredictionPositionRecord[],
  marketMap: Map<string, PredictionMarketRecord>,
): Record<string, PredictionUserPositionSnapshot[]> {
  const userPositionsMap: Record<string, PredictionUserPositionSnapshot[]> = {};

  for (const p of positions) {
    const market = marketMap.get(p.marketId);
    if (!market) continue;

    const positionSnapshot = buildPredictionUserPositionSnapshot(p, market);
    if (!positionSnapshot) continue;

    const existing = userPositionsMap[p.marketId] ?? [];
    userPositionsMap[p.marketId] = [...existing, positionSnapshot];
  }

  return userPositionsMap;
}

function createPredictionService() {
  const dbAdapter = new PredictionDbAdapter();
  return new PredictionMarketService({
    db: dbAdapter,
    wallet: {
      debit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.debit(
          userId,
          amount,
          reason,
          description ?? "",
          relatedId,
        ),
      credit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.credit(
          userId,
          amount,
          reason,
          description ?? "",
          relatedId,
        ),
      recordPnL: async ({ userId, pnl, reason, relatedId }) => {
        await WalletService.recordPnL(userId, pnl, reason, relatedId);
      },
      getBalance: (uid: string) => WalletService.getBalance(uid),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });
}

/**
 * GET /api/markets/predictions – list markets (optionally with user positions).
 *
 * WHY two caches: The public market list (12 s TTL) and per-user position
 * snapshots (30 s TTL) change at different rates. Trades invalidate both
 * for the acting user; admin resolve/cancel invalidates all position caches
 * because every user's P&L changes.
 *
 * WHY positions cache closure over marketMap: Position values (currentValue,
 * unrealizedPnL) depend on live market share counts. The closure captures
 * the market data from this request, so within a single response the data
 * is consistent. Across requests, the longer positions TTL can drift —
 * acceptable because the acting user's cache is always invalidated.
 *
 * WHY opt-in pagination: Same reasoning as perps — screener loads all,
 * external consumers can page.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const queryParse = MarketQuerySchema.merge(
    z.object({ userId: z.string().optional() }),
  )
    .partial()
    .safeParse(Object.fromEntries(searchParams));

  if (!queryParse.success) {
    return successResponse(
      {
        error: "Invalid query parameters",
        details: queryParse.error.flatten(),
      },
      400,
    );
  }

  const { userId } = queryParse.data;
  const usePagination = searchParams.has("limit") || searchParams.has("page");
  const page = Math.max(1, queryParse.data.page ?? 1);
  const limit = Math.min(100, Math.max(1, queryParse.data.limit ?? 20));

  const service = createPredictionService();

  let markets: PredictionMarketRecord[];
  let total: number | undefined;

  if (usePagination) {
    total = await service.countUnresolvedMarkets();
    const offset = (page - 1) * limit;
    markets = await service.listMarkets({ limit, offset });
  } else {
    markets = await getCacheOrFetch("all", () => service.listMarkets(), {
      namespace: CACHE_KEYS.MARKETS_API_PREDICTIONS_LIST,
      ttl: DEFAULT_TTLS.MARKETS_API_PREDICTIONS_LIST,
    });
  }

  const marketMap = new Map(markets.map((m) => [m.id, m]));

  const userPositionsMap = new Map<string, PredictionUserPositionSnapshot[]>();
  if (userId && authUser?.userId === userId) {
    try {
      const positionsRecord = await getCacheOrFetch(
        userId,
        async () => {
          const positions = await service.listUserPositions(userId);
          return buildUserPositionsRecord(positions, marketMap);
        },
        {
          namespace: CACHE_KEYS.MARKETS_API_PREDICTIONS_POSITIONS,
          ttl: DEFAULT_TTLS.MARKETS_API_PREDICTIONS_POSITIONS,
        },
      );
      for (const [k, v] of Object.entries(positionsRecord)) {
        userPositionsMap.set(k, v);
      }
    } catch (error) {
      logger.error(
        "Failed to fetch prediction market positions; returning public markets without positions",
        {
          requestedUserId: userId,
          authenticatedUserId: authUser.userId,
          dbUserId: authUser.dbUserId ?? null,
          privyId: authUser.privyId ?? null,
          url: request.url,
          error: error instanceof Error ? error.message : String(error),
        },
        "GET /api/markets/predictions",
      );
    }
  }

  const questionsData = markets.map((m) => {
    const yesShares = m.yesShares;
    const noShares = m.noShares;
    const yesProb = PredictionPricing.getCurrentPrice(
      yesShares,
      noShares,
      "yes",
    );
    const noProb = PredictionPricing.getCurrentPrice(yesShares, noShares, "no");
    const dbUserPositions = userPositionsMap.get(m.id) ?? [];
    const userPositions = dbUserPositions;
    const primaryPosition = userPositions[0] ?? null;

    return {
      id: m.id,
      // Frontend expects 'text' field for the question text
      text: m.question,
      question: m.question, // Also include as 'question' for backward compatibility
      status: m.status ?? (m.resolved ? "resolved" : "active"),
      resolution: m.resolution,
      resolved: m.resolved,
      // Frontend expects 'resolutionDate' for the end date
      resolutionDate: toISOOrNull(m.endDate),
      endDate: toISOOrNull(m.endDate), // Also include as 'endDate'
      createdDate: toISOOrNull(m.createdAt),
      yesShares,
      noShares,
      yesProbability: yesProb,
      noProbability: noProb,
      liquidity: m.liquidity,
      userPosition: primaryPosition,
      userPositions,
      resolutionProofUrl: m.resolutionProofUrl ?? null,
      resolutionDescription: m.resolutionDescription ?? null,
    };
  });

  logger.info(
    "Prediction markets fetched via core service",
    {
      count: questionsData.length,
      hasUserId: !!userId,
      paginated: usePagination,
    },
    "GET /api/markets/predictions",
  );

  const res = successResponse({
    success: true,
    questions: questionsData,
    count: questionsData.length,
    ...(usePagination ? { page, limit, total } : {}),
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
