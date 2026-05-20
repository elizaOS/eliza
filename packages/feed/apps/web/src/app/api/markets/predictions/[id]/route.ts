import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  PredictionDbAdapter,
  PredictionMarketService,
  PredictionPricing,
} from '@babylon/core/markets/prediction';
import {
  and,
  balanceTransactions,
  count,
  db,
  eq,
  inArray,
  npcTrades,
} from '@babylon/db';
import { FEE_CONFIG, WalletService } from '@babylon/engine';
import {
  logger,
  MarketQuerySchema,
  PredictionMarketIdSchema,
  toISOOrNull,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  buildPredictionUserPositionSnapshot,
  type PredictionUserPositionSnapshot,
} from '../_position-snapshot';
import { getPublicResolutionAudit } from '../_resolution-audit';

/**
 * GET /api/markets/predictions/[id]
 * Returns a single market (optionally with authenticated user's positions)
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const {
      error,
      user: authUser,
      rateLimitInfo,
    } = await publicRateLimit(request);
    if (error) return error;

    const { id: marketId } = PredictionMarketIdSchema.parse(
      await context.params
    );
    const { searchParams } = new URL(request.url);
    const queryParse = MarketQuerySchema.merge(
      z.object({ userId: z.string().optional() })
    )
      .partial()
      .safeParse(Object.fromEntries(searchParams));

    if (!queryParse.success) {
      return successResponse(
        {
          error: 'Invalid query parameters',
          details: queryParse.error.flatten(),
        },
        400
      );
    }

    const { userId } = queryParse.data;

    const service = new PredictionMarketService({
      db: new PredictionDbAdapter(),
      wallet: {
        debit: ({ userId, amount, reason, description, relatedId }) =>
          WalletService.debit(
            userId,
            amount,
            reason,
            description ?? '',
            relatedId
          ),
        credit: ({ userId, amount, reason, description, relatedId }) =>
          WalletService.credit(
            userId,
            amount,
            reason,
            description ?? '',
            relatedId
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

    const market =
      (await service.getMarket(marketId)) ??
      (await service.ensureMarketExists({ marketId }).catch(() => null));

    if (!market) {
      return successResponse({ error: 'Market not found' }, 404);
    }

    const yesShares = market.yesShares;
    const noShares = market.noShares;
    const yesProb = PredictionPricing.getCurrentPrice(
      yesShares,
      noShares,
      'yes'
    );
    const noProb = PredictionPricing.getCurrentPrice(yesShares, noShares, 'no');

    let userPositions: PredictionUserPositionSnapshot[] = [];
    let primaryPosition: PredictionUserPositionSnapshot | null = null;

    if (userId && authUser?.userId === userId) {
      const positions = await service.listUserPositions(userId);
      userPositions = positions
        .filter((p) => p.marketId === marketId && p.shares >= 0.01)
        .map((p) => buildPredictionUserPositionSnapshot(p, market))
        .filter(
          (position): position is PredictionUserPositionSnapshot =>
            position !== null
        );
      primaryPosition = userPositions[0] ?? null;
    }

    const [balanceTradeCountRows, npcTradeCountRows] = await Promise.all([
      db
        .select({ count: count() })
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.relatedId, marketId),
            inArray(balanceTransactions.type, ['pred_buy', 'pred_sell'])
          )
        ),
      db
        .select({ count: count() })
        .from(npcTrades)
        .where(
          and(
            eq(npcTrades.marketType, 'prediction'),
            eq(npcTrades.marketId, marketId)
          )
        ),
    ]);

    const tradeCount =
      Number(balanceTradeCountRows[0]?.count ?? 0) +
      Number(npcTradeCountRows[0]?.count ?? 0);

    const resolutionAudit = await getPublicResolutionAudit(marketId);

    const payload = {
      id: market.id,
      text: market.question,
      question: market.question,
      status: market.resolved ? 'resolved' : 'active',
      resolution: market.resolution ?? null,
      resolved: market.resolved,
      resolutionDate: toISOOrNull(market.endDate),
      endDate: toISOOrNull(market.endDate),
      createdDate: toISOOrNull(market.createdAt),
      yesShares,
      noShares,
      liquidity: market.liquidity,
      tradeCount,
      yesProbability: yesProb,
      noProbability: noProb,
      userPosition: primaryPosition,
      userPositions,
      resolutionProofUrl: market.resolutionProofUrl ?? null,
      resolutionDescription: market.resolutionDescription ?? null,
      resolutionAudit,
    };

    logger.info(
      'Prediction market fetched via core service',
      { marketId, hasUserId: !!userId },
      'GET /api/markets/predictions/[id]'
    );

    const res = successResponse({ success: true, market: payload });
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }
);
