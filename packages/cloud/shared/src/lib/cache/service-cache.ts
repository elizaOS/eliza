/**
 * Service-level caching utilities.
 * Provides consistent caching patterns for frequently accessed data.
 */

import { logger } from "../utils/logger";
import { cache } from "./client";

/**
 * Cache TTL configurations for different data types (in seconds).
 */
export const CACHE_TTL = {
  USER_PROFILE: 3600, // 1 hour
  CHARACTER_LIST: 900, // 15 minutes
  MODEL_PRICING: 86400, // 1 day
  ORGANIZATION_SETTINGS: 3600, // 1 hour
  API_KEY: 1800, // 30 minutes
  CREDIT_BALANCE: 300, // 5 minutes
  CONTAINER_STATUS: 60, // 1 minute
  AGENT_STATUS: 120, // 2 minutes
  STATISTICS: 300, // 5 minutes
} as const;

/**
 * Stale time configurations (time before background refresh) (in seconds).
 */
export const CACHE_STALE_TIME = {
  USER_PROFILE: 1800, // 30 minutes
  CHARACTER_LIST: 450, // 7.5 minutes
  MODEL_PRICING: 43200, // 12 hours
  ORGANIZATION_SETTINGS: 1800, // 30 minutes
  API_KEY: 900, // 15 minutes
  CREDIT_BALANCE: 150, // 2.5 minutes
  CONTAINER_STATUS: 30, // 30 seconds
  AGENT_STATUS: 60, // 1 minute
  STATISTICS: 150, // 2.5 minutes
} as const;

/**
 * Cache key builders for consistent key naming.
 */
export const CacheKeys = {
  userProfile: (userId: string) => `user:${userId}:profile`,
  organizationSettings: (orgId: string) => `org:${orgId}:settings`,
  characterList: (orgId: string) => `org:${orgId}:characters`,
  character: (characterId: string) => `character:${characterId}`,
  modelPricing: (provider?: string) => (provider ? `pricing:${provider}` : "pricing:all"),
  apiKey: (keyId: string) => `apikey:${keyId}`,
  creditBalance: (orgId: string) => `org:${orgId}:credits`,
  containerStatus: (containerId: string) => `container:${containerId}:status`,
  agentStatus: (agentId: string) => `agent:${agentId}:status`,
  statistics: (orgId: string, type: string) => `stats:${orgId}:${type}`,
} as const;

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
