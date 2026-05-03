/**
 * Service-level caching utilities.
 * Provides consistent caching patterns for frequently accessed data.
 */

import { logger } from "@/lib/utils/logger";
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
 * Invalidate cache for a specific key.
 *
 * @param key - Cache key
 */
export async function invalidateCache(key: string): Promise<void> {
  try {
    await cache.del(key);
    logger.debug(`[Cache] INVALIDATED: ${key}`);
  } catch (error) {
    logger.error(`[Cache] Error invalidating cache for ${key}:`, error);
  }
}

/**
 * Invalidate cache for a pattern (e.g., "user:123:*").
 *
 * @param pattern - Cache key pattern
 */
export async function invalidateCachePattern(pattern: string): Promise<void> {
  try {
    await cache.delPattern(pattern);
    logger.debug(`[Cache] INVALIDATED PATTERN: ${pattern}`);
  } catch (error) {
    logger.error(`[Cache] Error invalidating cache pattern ${pattern}:`, error);
  }
}

/**
 * Invalidate multiple cache keys.
 *
 * @param keys - Array of cache keys
 */
export async function invalidateCacheBatch(keys: string[]): Promise<void> {
  await Promise.all(keys.map((key) => invalidateCache(key)));
}
