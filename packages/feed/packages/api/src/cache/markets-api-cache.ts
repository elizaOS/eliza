/**
 * Cache invalidation for public markets list API routes (Redis cache-aside).
 *
 * WHY separate module: keeps route handlers thin; keys/TTLs live next to CACHE_KEYS.
 *
 * WHY in @feed/api, not in packages/core: Domain packages must stay
 * framework-agnostic (no Redis/API imports). Cache is infrastructure;
 * invalidation is wiring that belongs at the boundary (route handlers and
 * web-only adapters call these helpers).
 *
 * WHY pattern-based invalidation ('*'): getCacheOrFetch stores keys like
 * `{namespace}:{key}` (e.g. `markets:api:perps:snapshot`). A wildcard pattern
 * clears everything under a namespace without knowing individual keys — useful
 * when the set of cached keys might grow (e.g. per-page caches in the future).
 */

import {
  CACHE_KEYS,
  invalidateCache,
  invalidateCachePattern,
} from "./cache-service";

/** Drop cached perp snapshot after trades or price-impact writes. */
export async function invalidateMarketsApiPerpsSnapshot(): Promise<void> {
  await invalidateCachePattern("*", {
    namespace: CACHE_KEYS.MARKETS_API_PERPS,
  });
}

/** Drop cached prediction market list after any trade, resolve, or cancel. */
export async function invalidateMarketsApiPredictionsList(): Promise<void> {
  await invalidateCachePattern("*", {
    namespace: CACHE_KEYS.MARKETS_API_PREDICTIONS_LIST,
  });
}

/** Drop cached positions for one user (their list view embeds positions). */
export async function invalidateMarketsApiPredictionsPositionsForUser(
  userId: string,
): Promise<void> {
  await invalidateCache(userId, {
    namespace: CACHE_KEYS.MARKETS_API_PREDICTIONS_POSITIONS,
  });
}

/** After a prediction trade: list changes globally; this user's positions change. */
export async function invalidateMarketsApiPredictionsAfterUserTrade(
  userId: string,
): Promise<void> {
  await Promise.all([
    invalidateMarketsApiPredictionsList(),
    invalidateMarketsApiPredictionsPositionsForUser(userId),
  ]);
}

/** After admin resolve/cancel (or any global prediction mutation): drop list + all cached position blobs. */
export async function invalidateMarketsApiPredictionsListAndAllPositions(): Promise<void> {
  await Promise.all([
    invalidateMarketsApiPredictionsList(),
    invalidateCachePattern("*", {
      namespace: CACHE_KEYS.MARKETS_API_PREDICTIONS_POSITIONS,
    }),
  ]);
}
