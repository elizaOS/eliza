import {
  addPublicReadHeaders,
  authenticate,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { PerpOpenPositionSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { createPerpMarketService } from '../_adapters';

/**
 * POST /api/markets/perps/preview
 * Returns the canonical open-order execution preview for a perp order.
 *
 * This route intentionally reuses the same execution engine as the actual
 * order placement flow for supported cases. If the market changes before submit,
 * the preview can become stale even though the pricing logic remains identical.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const body = await request.json();
  const { ticker, side, size, leverage } = PerpOpenPositionSchema.parse(body);
  const normalizedSide = side.toLowerCase() as 'long' | 'short';
  const numericSize = typeof size === 'string' ? Number(size) : size;
  let authenticatedUser: Awaited<ReturnType<typeof authenticate>> | null = null;
  if (request.headers.get('authorization')) {
    authenticatedUser = await authenticate(request);
  }

  const service = createPerpMarketService();
  const preview = authenticatedUser
    ? {
        settlementMode: 'offchain',
        ...(await service.previewOrder({
          userId: authenticatedUser.userId,
          ticker,
          side: normalizedSide,
          size: numericSize,
          leverage,
        })),
      }
    : {
        settlementMode: 'offchain',
        ...(await service.previewOpenPosition({
          ticker,
          side: normalizedSide,
          size: numericSize,
          leverage,
        })),
      };

  const res = successResponse({ preview });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
