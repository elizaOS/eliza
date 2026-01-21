/**
 * Cache Service
 *
 * @description Provides intelligent caching layer for frequently accessed data.
 * Uses Redis when available, falls back to in-memory cache. Supports automatic
 * TTL management, cache invalidation patterns, and graceful degradation.
 *
 * Features:
 * - Automatic TTL management
 * - Cache invalidation patterns
 * - Fallback to database on cache miss
 * - Graceful degradation if Redis unavailable
 * - Works with any Redis server via standard protocol
 */

import { logger } from "@polyagent/shared";
import { getRedisClient, isRedisAvailable } from "../redis";

/**
 * Cache options
 *
 * @description Configuration options for cache operations.
 */
export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  compress?: boolean; // Compress large objects (not currently implemented)
  namespace?: string; // Cache key prefix
}

/**
 * Cache entry structure
 *
 * @description Internal structure for in-memory cache entries.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// In-memory fallback cache (for when Redis is unavailable)
const memoryCache = new Map<string, CacheEntry<unknown>>();

/**
 * Cache key prefixes for different data types
 *
 * @description Standardized cache key prefixes used throughout the application
 * for consistent cache key naming.
 */
export const CACHE_KEYS = {
  POST: "post",
  POSTS_LIST: "posts:list",
  POSTS_BY_ACTOR: "posts:actor",
  POSTS_FOLLOWING: "posts:following",
  USER: "user",
  USER_BALANCE: "user:balance",
  ACTOR: "actor",
  ORGANIZATION: "org",
  MARKET: "market",
  MARKETS_LIST: "markets:list",
  TRENDING_TAGS: "trending:tags",
  WIDGET: "widget",
  NFT_OWNERSHIP: "nft:ownership",
} as const;

/**
 * Default TTLs for different data types (in seconds)
 *
 * @description Default time-to-live values for different data types based on
 * their change frequency. Real-time data has short TTLs, rarely changing data
 * has long TTLs.
 */
export const DEFAULT_TTLS = {
  // Real-time data - very short TTL
  POSTS_LIST: 10, // 10 seconds
  POSTS_FOLLOWING: 15, // 15 seconds

  // Semi-real-time data - short TTL
  POST: 30, // 30 seconds
  USER_BALANCE: 30, // 30 seconds
  MARKET: 60, // 1 minute
  MARKETS_LIST: 60, // 1 minute

  // Moderate change frequency - medium TTL
  USER: 300, // 5 minutes
  TRENDING_TAGS: 300, // 5 minutes
  WIDGET: 300, // 5 minutes
  NFT_OWNERSHIP: 60, // 1 minute (NFT ownership can change, shorter TTL for security)

  // Rarely changing data - long TTL
  ACTOR: 3600, // 1 hour
  ORGANIZATION: 3600, // 1 hour
  POSTS_BY_ACTOR: 120, // 2 minutes (actors post regularly)
} as const;

/**
 * Clean expired entries from memory cache
 *
 * @description Removes expired entries from the in-memory cache. Called periodically
 * to prevent memory leaks.
 *
 * @private
 */
function cleanMemoryCache(): void {
  const now = Date.now();
  const toDelete: string[] = [];

  memoryCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) {
      toDelete.push(key);
    }
  });

  toDelete.forEach((key) => memoryCache.delete(key));
}

// Clean memory cache every minute
setInterval(cleanMemoryCache, 60000);

/**
 * Get value from cache
 *
 * @description Retrieves a value from cache (Redis or in-memory). Returns null
 * if not found or expired.
 *
 * @param {string} key - Cache key
 * @param {CacheOptions} [options={}] - Cache options (namespace, etc.)
 * @returns {Promise<T | null>} Cached value or null if not found
 *
 * @example
 * ```typescript
 * const user = await getCache<User>('user:123', { namespace: CACHE_KEYS.USER });
 * if (user) {
 *   // Use cached user
 * }
 * ```
 */
export async function getCache<T>(
  key: string,
  options: CacheOptions = {},
): Promise<T | null> {
  const fullKey = options.namespace ? `${options.namespace}:${key}` : key;

  const client = getRedisClient();
  if (client) {
    const cached = await client.get(fullKey);

    if (cached !== null && cached !== undefined) {
      if (!cached || cached.trim() === "") {
        logger.warn(
          "Empty cached value in Redis",
          { key: fullKey },
          "CacheService",
        );
        return null;
      }

      logger.debug("Cache hit (Redis)", { key: fullKey }, "CacheService");
      return JSON.parse(cached) as T;
    }

    logger.debug("Cache miss (Redis)", { key: fullKey }, "CacheService");
    return null;
  }

  const entry = memoryCache.get(fullKey);

  if (entry) {
    if (entry.expiresAt > Date.now()) {
      logger.debug("Cache hit (Memory)", { key: fullKey }, "CacheService");
      return entry.value as T;
    }
    memoryCache.delete(fullKey);
    logger.debug("Cache expired (Memory)", { key: fullKey }, "CacheService");
  }

  logger.debug("Cache miss (Memory)", { key: fullKey }, "CacheService");
  return null;
}

/**
 * Set value in cache
 *
 * @description Stores a value in cache (Redis or in-memory) with optional TTL.
 * Serializes the value to JSON before storing.
 *
 * @param {string} key - Cache key
 * @param {T} value - Value to cache
 * @param {CacheOptions} [options={}] - Cache options (ttl, namespace, etc.)
 * @returns {Promise<void>}
 *
 * @example
 * ```typescript
 * await setCache('user:123', userData, {
 *   namespace: CACHE_KEYS.USER,
 *   ttl: DEFAULT_TTLS.USER
 * });
 * ```
 */
export async function setCache<T>(
  key: string,
  value: T,
  options: CacheOptions = {},
): Promise<void> {
  const fullKey = options.namespace ? `${options.namespace}:${key}` : key;
  const ttl = options.ttl || 300;

  const serialized = JSON.stringify(value);
  const client = getRedisClient();

  if (client) {
    await client.set(fullKey, serialized, "EX", ttl);
    logger.debug("Cache set (Redis)", { key: fullKey, ttl }, "CacheService");
    return;
  }

  const expiresAt = Date.now() + ttl * 1000;
  memoryCache.set(fullKey, { value, expiresAt });
  logger.debug("Cache set (Memory)", { key: fullKey, ttl }, "CacheService");
}

/**
 * Invalidate cache entry
 *
 * @description Removes a specific cache entry from both Redis and in-memory cache.
 *
 * @param {string} key - Cache key to invalidate
 * @param {CacheOptions} [options={}] - Cache options (namespace, etc.)
 * @returns {Promise<void>}
 *
 * @example
 * ```typescript
 * await invalidateCache('user:123', { namespace: CACHE_KEYS.USER });
 * ```
 */
export async function invalidateCache(
  key: string,
  options: CacheOptions = {},
): Promise<void> {
  const fullKey = options.namespace ? `${options.namespace}:${key}` : key;

  const client = getRedisClient();
  if (client) {
    await client.del(fullKey);
    logger.debug("Cache invalidated (Redis)", { key: fullKey }, "CacheService");
  }

  memoryCache.delete(fullKey);
  logger.debug("Cache invalidated (Memory)", { key: fullKey }, "CacheService");
}

/**
 * Invalidate cache entries matching a pattern
 *
 * @description Removes all cache entries matching a pattern. Uses SCAN for
 * Redis to efficiently find matching keys.
 *
 * @param {string} pattern - Pattern to match (e.g., 'user:*')
 * @param {CacheOptions} [options={}] - Cache options (namespace, etc.)
 * @returns {Promise<void>}
 *
 * @example
 * ```typescript
 * await invalidateCachePattern('user:*', { namespace: CACHE_KEYS.USER });
 * ```
 */
export async function invalidateCachePattern(
  pattern: string,
  options: CacheOptions = {},
): Promise<void> {
  const fullPattern = options.namespace
    ? `${options.namespace}:${pattern}`
    : pattern;

  // Invalidate in Redis
  const client = getRedisClient();
  if (client) {
    // Use SCAN to find matching keys
    const stream = client.scanStream({ match: fullPattern });
    const keys: string[] = [];

    stream.on("data", (resultKeys: string[]) => {
      keys.push(...resultKeys);
    });

    await new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });

    if (keys.length > 0) {
      await client.del(...keys);
      logger.info(
        "Cache pattern invalidated (Redis)",
        { pattern: fullPattern, count: keys.length },
        "CacheService",
      );
    }
  }

  // Invalidate in memory cache
  const memoryKeys = Array.from(memoryCache.keys()).filter((key) =>
    key.includes(pattern),
  );
  memoryKeys.forEach((key) => memoryCache.delete(key));

  if (memoryKeys.length > 0) {
    logger.debug(
      "Cache pattern invalidated (Memory)",
      { pattern: fullPattern, count: memoryKeys.length },
      "CacheService",
    );
  }
}

/**
 * Get or set pattern - fetch from cache or execute function and cache result
 *
 * @description Implements the cache-aside pattern. Checks cache first, and if
 * not found, executes the fetch function and caches the result.
 *
 * @param {string} key - Cache key
 * @param {() => Promise<T>} fetchFn - Function to fetch data if cache miss
 * @param {CacheOptions} [options={}] - Cache options (ttl, namespace, etc.)
 * @returns {Promise<T>} Cached or freshly fetched value
 *
 * @example
 * ```typescript
 * const posts = await getCacheOrFetch(
 *   'posts:recent',
 *   () => db().getRecentPosts(100),
 *   { namespace: CACHE_KEYS.POSTS_LIST, ttl: DEFAULT_TTLS.POSTS_LIST }
 * );
 * ```
 */
export async function getCacheOrFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  // Try to get from cache
  const cached = await getCache<T>(key, options);

  if (cached !== null) {
    return cached;
  }

  // Cache miss - fetch from source
  logger.debug("Fetching data for cache", { key }, "CacheService");
  const data = await fetchFn();

  // Cache the result
  await setCache(key, data, options);

  return data;
}

/**
 * Warm up cache with data
 *
 * @description Pre-populates cache with data. Alias for setCache for semantic clarity.
 *
 * @param {string} key - Cache key
 * @param {T} value - Value to cache
 * @param {CacheOptions} [options={}] - Cache options
 * @returns {Promise<void>}
 */
export async function warmCache<T>(
  key: string,
  value: T,
  options: CacheOptions = {},
): Promise<void> {
  await setCache(key, value, options);
}

/**
 * Get cache statistics (memory cache only)
 *
 * @description Returns statistics about the in-memory cache, including entry counts
 * and Redis availability. Useful for monitoring and debugging.
 *
 * @returns {object} Cache statistics including totalEntries, activeEntries, expiredEntries,
 * redisAvailable
 */
export function getCacheStats() {
  const now = Date.now();
  let activeEntries = 0;
  let expiredEntries = 0;

  memoryCache.forEach((entry) => {
    if (entry.expiresAt > now) {
      activeEntries++;
    } else {
      expiredEntries++;
    }
  });

  return {
    totalEntries: memoryCache.size,
    activeEntries,
    expiredEntries,
    redisAvailable: isRedisAvailable(),
  };
}

/**
 * Clear all cache (use with caution!)
 *
 * @description Clears all in-memory cache entries. Redis cache clearing is not
 * implemented for safety reasons (to avoid clearing other application data).
 *
 * @returns {Promise<void>}
 *
 * @warning Use with extreme caution! This will clear all cached data and may
 * impact application performance.
 */
export async function clearAllCache(): Promise<void> {
  logger.warn("Clearing all cache", undefined, "CacheService");

  // Clear memory cache
  memoryCache.clear();

  // Clear Redis cache (if available and safe to do)
  if (isRedisAvailable()) {
    // Only clear our namespaced keys, not the entire Redis instance
    logger.warn(
      "Redis cache clear requested but not implemented for safety",
      undefined,
      "CacheService",
    );
  }
}
