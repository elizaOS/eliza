/**
 * Trade Cache Invalidation Utilities
 *
 * @description Provides functions to invalidate cache when trades are created
 * to ensure fresh data is fetched on next request. Uses an injectable cache
 * client to allow different caching strategies.
 */

import { logger } from '@babylon/shared';

/**
 * Cache invalidation client interface
 *
 * @description Interface for cache clients that support pattern-based deletion.
 * Can be implemented with Redis, in-memory cache, etc.
 */
export interface CacheInvalidationClient {
  /**
   * Delete all keys matching a pattern
   *
   * @param {string} pattern - Pattern to match (e.g., "market-trades:*")
   * @returns {Promise<number>} Number of keys deleted
   */
  deleteByPattern(pattern: string): Promise<number>;
}

let cacheClient: CacheInvalidationClient | null = null;

/**
 * Set the cache invalidation client
 *
 * @description Injects the cache client that will be used for invalidation.
 * Should be called once during app initialization.
 *
 * @param {CacheInvalidationClient} client - Cache client instance
 *
 * @example
 * ```typescript
 * // In web app initialization
 * setCacheInvalidationClient(redisCacheClient);
 * ```
 */
export function setCacheInvalidationClient(
  client: CacheInvalidationClient
): void {
  cacheClient = client;
}

/**
 * Invalidate all trades cache for a specific prediction market using pattern-based deletion
 *
 * @param {string} marketId - Market ID to invalidate cache for
 * @returns {Promise<void>}
 */
export async function invalidatePredictionTradesCache(
  marketId: string
): Promise<void> {
  if (cacheClient) {
    // Support versioned keys (e.g. `prediction-trades:v2:<marketId>:...`).
    const pattern = `market-trades:prediction-trades*:${marketId}:*`;
    const deletedCount = await cacheClient.deleteByPattern(pattern);

    if (deletedCount > 0) {
      logger.debug(
        `Deleted ${deletedCount} cache keys for market ${marketId}`,
        undefined,
        'TradeCache'
      );
    }
  } else {
    // If no cache client, cache is in-memory and will expire naturally
    logger.debug(
      'No cache client available, cache will expire naturally',
      { marketId },
      'TradeCache'
    );
  }

  logger.info(
    `Invalidated prediction trades cache for market ${marketId}`,
    undefined,
    'TradeCache'
  );
}

/**
 * Invalidate all trades cache for a specific perpetual market using pattern-based deletion
 *
 * @param {string} ticker - Ticker to invalidate cache for
 * @returns {Promise<void>}
 */
export async function invalidatePerpTradesCache(ticker: string): Promise<void> {
  if (cacheClient) {
    const tickerKey = ticker.toLowerCase();
    const pattern = `market-trades:perp-trades:${tickerKey}:*`;
    const deletedCount = await cacheClient.deleteByPattern(pattern);

    if (deletedCount > 0) {
      logger.debug(
        `Deleted ${deletedCount} cache keys for ticker ${ticker}`,
        undefined,
        'TradeCache'
      );
    }
  } else {
    logger.debug(
      'No cache client available, cache will expire naturally',
      { ticker },
      'TradeCache'
    );
  }

  logger.info(
    `Invalidated perp trades cache for ticker ${ticker}`,
    undefined,
    'TradeCache'
  );
}

/**
 * Invalidate trades cache after a prediction market trade
 * Call this after creating a position or balance transaction for a prediction market
 *
 * @param {string} marketId - Market ID to invalidate cache for
 * @returns {Promise<void>}
 */
export async function invalidateAfterPredictionTrade(
  marketId: string
): Promise<void> {
  await invalidatePredictionTradesCache(marketId);
}

/**
 * Invalidate trades cache after a perpetual futures trade
 * Call this after opening/closing a perp position or creating related balance transaction
 *
 * @param {string} ticker - Ticker to invalidate cache for
 * @returns {Promise<void>}
 */
export async function invalidateAfterPerpTrade(ticker: string): Promise<void> {
  await invalidatePerpTradesCache(ticker);
}
