import {
  authenticate,
  checkProgress,
  checkRateLimitAsync,
  invalidateMarketsApiPerpsSnapshot,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { handlePlayerTrade } from '@babylon/engine';
import {
  fireAndForgetWithRetry,
  logger,
  PerpOpenPositionSchema,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';
import { createPerpMarketService } from '../_adapters';

/**
 * POST /api/markets/perps/open
 * Open a new perpetual futures position.
 *
 * Uses PerpMarketService with SSE broadcast and price impact protection.
 * Price impact adjustment (BF-75) is handled inside the service via PriceImpactPort,
 * ensuring ALL position creation paths (open, add, flip) are protected.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Rate limit: 10 positions per minute per user
  const rateLimitResult = await checkRateLimitAsync(
    user.userId,
    RATE_LIMIT_CONFIGS.OPEN_POSITION
  );
  if (!rateLimitResult.allowed)
    return rateLimitError(rateLimitResult.retryAfter);

  const body = await request.json();
  const { ticker, side, size, leverage } = PerpOpenPositionSchema.parse(body);

  const normalizedSide = side.toLowerCase() as 'long' | 'short';
  const numericSize = typeof size === 'string' ? Number(size) : size;

  // Create service with fee processor, broadcast, and price impact protection
  const service = createPerpMarketService({
    withFeeProcessor: true,
    withBroadcast: true,
    withPriceImpact: true,
  });

  const result = await service.openPosition({
    userId: user.userId,
    ticker,
    side: normalizedSide,
    size: numericSize,
    leverage,
  });

  // Track analytics event (fire and forget)
  trackServerEvent(user.userId, 'trade_opened', {
    type: 'perp',
    ticker,
    side: normalizedSide,
    size: numericSize,
    leverage,
    entryPrice: result.entryPrice ?? 0,
    marginPaid: result.marginPaid ?? 0,
    feeCharged: result.feePaid,
    positionId: result.positionId,
  }).catch((error) => {
    logger.warn(
      'Failed to track trade_opened event',
      { error: error instanceof Error ? error.message : String(error) },
      'PerpOpen'
    );
  });

  // Handle player influence - significant trades affect NPC memory
  // This adds the trade to NPC memories of affiliated actors
  fireAndForgetWithRetry(
    () => handlePlayerTrade(user.userId, ticker, normalizedSide, numericSize),
    {
      logContext: 'PerpOpen',
      metadata: {
        userId: user.userId,
        ticker,
        side: normalizedSide,
        size: numericSize,
      },
    }
  );

  void checkProgress(user.userId, { type: 'perp_trade', ticker });
  void invalidateMarketsApiPerpsSnapshot();

  return successResponse(
    {
      position: result,
      marginPaid: result.marginPaid,
      fee: {
        amount: result.feePaid,
        referrerPaid: 0,
      },
      newBalance: result.balance,
    },
    201
  );
});
