import {
  addPublicReadHeaders,
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { createPerpMarketService } from './_adapters';
import { mergeOrganizationMetadataForPerpMarkets } from './_org-metadata';

const PerpsListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().positive().max(100),
  })
  .partial();

/**
 * GET /api/markets/perps
 * Returns perpetual markets snapshot (single source from PerpMarketService).
 *
 * WHY cache-aside: The full snapshot hits the DB on every request; short-TTL
 * Redis cache (8 s) eliminates redundant reads under burst traffic while
 * write-time invalidation (on open/close/price-impact) keeps it fresh.
 *
 * WHY opt-in pagination: The screener loads all markets and sorts client-side,
 * so the default (no page/limit) returns the full cached list. External
 * consumers can pass ?page=N&limit=M to get bounded pages (bypasses cache
 * to avoid key explosion with low hit rates).
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const parsed = PerpsListQuerySchema.safeParse(
    Object.fromEntries(searchParams)
  );
  const usePagination = searchParams.has('limit') || searchParams.has('page');
  if (!parsed.success && usePagination) {
    const res = successResponse(
      {
        error: 'Invalid query parameters',
        details: parsed.error.flatten(),
      },
      400
    );
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }

  const page = parsed.success ? (parsed.data.page ?? 1) : 1;
  const limit = parsed.success ? (parsed.data.limit ?? 20) : 20;

  const service = createPerpMarketService();

  let markets: Awaited<ReturnType<typeof service.getMarketsSnapshot>>;
  let total: number | undefined;
  const fetchDbMarkets = async () => {
    if (usePagination) {
      total = await service.countMarkets();
      const offset = (page - 1) * limit;
      return await service.getMarketsSnapshot({ limit, offset });
    }

    return await getCacheOrFetch(
      'snapshot',
      () => service.getMarketsSnapshot(),
      {
        namespace: CACHE_KEYS.MARKETS_API_PERPS,
        ttl: DEFAULT_TTLS.MARKETS_API_PERPS,
      }
    );
  };

  markets = await fetchDbMarkets();
  markets = await mergeOrganizationMetadataForPerpMarkets(markets);

  logger.info(
    'Perpetual markets fetched successfully',
    { count: markets.length, paginated: usePagination },
    'GET /api/markets/perps'
  );

  const res = successResponse({
    success: true,
    markets,
    count: markets.length,
    ...(usePagination ? { page, limit, total } : {}),
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
