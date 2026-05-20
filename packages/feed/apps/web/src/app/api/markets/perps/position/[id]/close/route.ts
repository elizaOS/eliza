import {
  authenticate,
  checkRateLimitAsync,
  invalidateMarketsApiPerpsSnapshot,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { handlePlayerTrade } from '@babylon/engine';
import {
  ClosePerpPositionSchema,
  fireAndForgetWithRetry,
  logger,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { trackServerEvent } from '@/lib/posthog/server';
import { createPerpMarketService } from '../../../_adapters';

const IdParamSchema = z.object({
  id: z.string(),
});

/**
 * POST /api/markets/perps/position/[id]/close
 * Close an existing perpetual futures position (full or partial).
 *
 * Supports partial close via `percentage` body param (0-1, e.g., 0.5 = 50%).
 * Uses PerpMarketService with SSE broadcast enabled for real-time UI updates.
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const user = await authenticate(request);

    // Rate limit: 10 closes per minute per user
    const rateLimitResult = await checkRateLimitAsync(
      user.userId,
      RATE_LIMIT_CONFIGS.CLOSE_POSITION
    );
    if (!rateLimitResult.allowed)
      return rateLimitError(rateLimitResult.retryAfter);

    const { id: positionId } = IdParamSchema.parse(await context.params);

    // Parse and validate request body (optional for partial close)
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // Body is optional for this endpoint
    }
    const parsed =
      Object.keys(body).length > 0
        ? ClosePerpPositionSchema.parse(body)
        : {
            percentage: undefined as number | undefined,
            slippage: undefined as number | undefined,
            orderType: 'market' as const,
            limitPrice: undefined as number | undefined,
          };

    // Create service with fee processor, broadcast, and price impact protection
    // Price impact adjustment (BF-75) is handled inside the service via PriceImpactPort,
    // using average fill pricing for fair close execution.
    const service = createPerpMarketService({
      withFeeProcessor: true,
      withBroadcast: true,
      withPriceImpact: true,
    });

    const result = await service.closePosition({
      userId: user.userId,
      positionId,
      percentage: parsed.percentage,
      maxSlippage: parsed.slippage,
    });

    // Track analytics event (fire and forget)
    trackServerEvent(user.userId, 'trade_closed', {
      type: 'perp',
      ticker: result.ticker,
      side: result.side,
      size: result.size,
      leverage: result.leverage,
      entryPrice: result.entryPrice ?? 0,
      exitPrice: result.exitPrice ?? 0,
      realizedPnL: result.realizedPnL ?? 0,
      pnlPercent:
        result.marginPaid && result.marginPaid > 0
          ? ((result.realizedPnL ?? 0) / result.marginPaid) * 100
          : 0,
      feeCharged: result.feePaid,
      wasLiquidated: false,
      positionId,
    }).catch((error) => {
      logger.warn(
        'Failed to track trade_closed event',
        { error: error instanceof Error ? error.message : String(error) },
        'PerpClose'
      );
    });

    // Handle player influence - closing positions also affects NPC memory
    // The opposite side represents the closing action
    const closingSide = result.side === 'long' ? 'short' : 'long';
    fireAndForgetWithRetry(
      () =>
        handlePlayerTrade(user.userId, result.ticker, closingSide, result.size),
      {
        logContext: 'PerpClose',
        metadata: {
          userId: user.userId,
          ticker: result.ticker,
          side: closingSide,
          size: result.size,
        },
      }
    );

    void invalidateMarketsApiPerpsSnapshot();

    return successResponse({
      position: result,
      grossSettlement:
        result.realizedPnL !== undefined && result.marginPaid !== undefined
          ? result.marginPaid + result.realizedPnL
          : undefined,
      netSettlement:
        result.realizedPnL !== undefined && result.marginPaid !== undefined
          ? Math.max(0, result.marginPaid + result.realizedPnL - result.feePaid)
          : undefined,
      marginReturned: result.marginPaid,
      pnl: result.realizedPnL,
      fee: {
        amount: result.feePaid,
        referrerPaid: 0,
      },
      wasLiquidated: false,
      newBalance: result.balance,
    });
  }
);
