/**
 * Service-level caching utilities.
 * Provides consistent caching patterns for frequently accessed data.
 *
 * Cache keys and TTLs live in `./keys` (`CacheKeys` / `CacheTTL`) and are NOT
 * redefined here. This module used to export its own `CacheKeys`, which
 * shadowed that canonical one from the same directory while building
 * unversioned keys (`org:<id>:credits` against the canonical
 * `org:<id>:credits:v1`) — so an import that picked the wrong `CacheKeys`
 * wrote entries `CacheInvalidation` would never evict.
 */

import { logger } from "../utils/logger";
import { cache } from "./client";

/**
 * Generic caching wrapper for service methods.
 * Provides automatic caching, error handling, and logging.
 *
 * @param key - Cache key
 * @param ttl - Time to live in seconds
 * @param fetcher - Function that fetches the data
 * @returns Cached or fresh data
 */
export async function withCache<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  try {
    // Try to get from cache
    const cached = await cache.get<T>(key);
    if (cached !== null) {
      logger.debug(`[Cache] HIT: ${key}`);
      return cached;
    }

    logger.debug(`[Cache] MISS: ${key}`);
  } catch (error) {
    logger.warn(`[Cache] Error reading from cache for key ${key}:`, error);
  }

  // Fetch fresh data
  const data = await fetcher();

  // Store in cache (fire and forget)
  cache
    .set(key, data, ttl)
    .catch((error) => logger.error(`[Cache] Error writing to cache for key ${key}:`, error));

  return data;
}

/**
 * Stale-while-revalidate caching wrapper.
 * Returns stale data immediately while refreshing in background.
 *
 * @param key - Cache key
 * @param ttl - Time to live in seconds
 * @param staleTime - Time before background refresh in seconds
 * @param fetcher - Function that fetches the data
 * @returns Cached (possibly stale) or fresh data
 */
export async function withStaleWhileRevalidate<T>(
  key: string,
  ttl: number,
  staleTime: number,
  fetcher: () => Promise<T>,
): Promise<T | null> {
  try {
    return await cache.getWithSWR<T>(key, staleTime, fetcher, ttl);
  } catch (error) {
    logger.error(`[Cache] Error in stale-while-revalidate for key ${key}:`, error);
    // Fallback to direct fetch
    return await fetcher();
  }
}

/**
 * Batch cache get/set operations for better performance.
 *
 * @param keys - Array of cache keys
 * @param ttl - Time to live in seconds
 * @param fetcher - Function that fetches all data (receives keys that were cache misses)
 * @returns Map of key to data
 */
export async function withBatchCache<T>(
  keys: string[],
  ttl: number,
  fetcher: (missedKeys: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  const missedKeys: string[] = [];

  // Try to get all from cache
  await Promise.all(
    keys.map(async (key) => {
      try {
        const cached = await cache.get<T>(key);
        if (cached !== null) {
          result.set(key, cached);
          logger.debug(`[Cache] HIT: ${key}`);
        } else {
          missedKeys.push(key);
          logger.debug(`[Cache] MISS: ${key}`);
        }
      } catch (error) {
        logger.warn(`[Cache] Error reading from cache for key ${key}:`, error);
        missedKeys.push(key);
      }
    }),
  );

  // Fetch missing data
  if (missedKeys.length > 0) {
    const freshData = await fetcher(missedKeys);

    // Store in cache (fire and forget)
    Promise.all(
      Array.from(freshData.entries()).map(([key, data]) =>
        cache
          .set(key, data, ttl)
          .catch((error) => logger.error(`[Cache] Error writing to cache for key ${key}:`, error)),
      ),
    );

    // Add to result
    freshData.forEach((data, key) => result.set(key, data));
  }

  return result;
}

/**
 * Raised when a cache invalidation could not be confirmed against the backend.
 *
 * Invalidation is security-sensitive: revoking an API key, logging a user out,
 * or changing a permission all rely on the stale cached copy actually being
 * removed. If the backend delete fails (or a pattern sweep is left incomplete)
 * the caller must know so it can fail closed — e.g. reject the mutation, retry,
 * or refuse to report success — rather than serve the revoked/stale value until
 * its TTL lapses. (#13417)
 */
export class CacheInvalidationError extends Error {
  constructor(
    message: string,
    readonly target: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CacheInvalidationError";
  }
}

/**
 * Invalidate cache for a specific key. Fails closed.
 *
 * @param key - Cache key
 * @throws {CacheInvalidationError} when the backend delete was not confirmed.
 *   Previously this swallowed all errors and returned normally, so a failed
 *   delete (Redis down/network blip) was reported as a successful invalidation
 *   and the stale entry — e.g. a just-revoked API key or a logged-out session
 *   — kept serving from cache until its TTL expired.
 */
export async function invalidateCache(key: string): Promise<void> {
  let deleted: boolean;
  try {
    deleted = await cache.delConfirmed(key);
  } catch (error) {
    // error-policy:J1 — a thrown delete is an unconfirmed invalidation; surface
    // it so the security-sensitive caller can fail closed.
    logger.error(`[Cache] Error invalidating cache for ${key}:`, error);
    throw new CacheInvalidationError(`Failed to invalidate cache key ${key}`, key, {
      cause: error,
    });
  }

  if (!deleted) {
    // error-policy:J1 — backend rejected the delete; do not fabricate success.
    logger.error(`[Cache] Invalidation not confirmed for ${key}`);
    throw new CacheInvalidationError(`Cache invalidation not confirmed for key ${key}`, key);
  }

  logger.debug(`[Cache] INVALIDATED: ${key}`);
}

/**
 * Invalidate cache for a pattern (e.g., "user:123:*"). Fails closed.
 *
 * @param pattern - Cache key pattern
 * @throws {CacheInvalidationError} when the pattern sweep was not confirmed
 *   complete (thrown scan/del, or the runaway-iteration guard left matching
 *   keys behind). A partial sweep previously returned as if it were complete.
 */
export async function invalidateCachePattern(pattern: string): Promise<void> {
  let deleted: boolean;
  try {
    deleted = await cache.delPatternConfirmed(pattern);
  } catch (error) {
    // error-policy:J1 — unconfirmed invalidation must not read as success.
    logger.error(`[Cache] Error invalidating cache pattern ${pattern}:`, error);
    throw new CacheInvalidationError(`Failed to invalidate cache pattern ${pattern}`, pattern, {
      cause: error,
    });
  }

  if (!deleted) {
    // error-policy:J1 — incomplete pattern sweep left matching keys behind.
    logger.error(`[Cache] Pattern invalidation incomplete for ${pattern}`);
    throw new CacheInvalidationError(
      `Cache pattern invalidation incomplete for ${pattern}`,
      pattern,
    );
  }

  logger.debug(`[Cache] INVALIDATED PATTERN: ${pattern}`);
}

/**
 * Invalidate multiple cache keys. Fails closed.
 *
 * Every key is attempted (a failing key does not short-circuit the rest), but
 * the call rejects if ANY key could not be invalidated so the caller never
 * mistakes a partial sweep for a full one.
 *
 * @param keys - Array of cache keys
 * @throws {CacheInvalidationError} naming every key whose invalidation was not
 *   confirmed.
 */
export async function invalidateCacheBatch(keys: string[]): Promise<void> {
  const results = await Promise.allSettled(keys.map((key) => invalidateCache(key)));
  const failedKeys = keys.filter((_key, index) => results[index].status === "rejected");

  if (failedKeys.length > 0) {
    // error-policy:J1 — report the exact keys still potentially served stale.
    const firstRejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw new CacheInvalidationError(
      `Failed to invalidate ${failedKeys.length} of ${keys.length} cache keys: ${failedKeys.join(", ")}`,
      failedKeys.join(","),
      { cause: firstRejection?.reason },
    );
  }
}
