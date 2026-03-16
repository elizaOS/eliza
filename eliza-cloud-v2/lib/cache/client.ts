/**
 * Redis-based cache client with stale-while-revalidate support and circuit breaker.
 */

import { Redis } from "@upstash/redis";
import { logger } from "@/lib/utils/logger";

/**
 * Cached value wrapper with metadata for stale-while-revalidate.
 */
interface CachedValue<T> {
  /** The cached data. */
  data: T;
  /** Timestamp when the value was cached. */
  cachedAt: number;
  /** Timestamp when the value becomes stale. */
  staleAt: number;
}

/**
 * Redis cache client with circuit breaker, stale-while-revalidate, and error handling.
 */
export class CacheClient {
  private redis: Redis | null = null;
  private enabled: boolean | null = null;
  private initialized = false;
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly MAX_FAILURES = 5;
  private readonly CIRCUIT_BREAKER_TIMEOUT = 60000;
  private revalidationQueue = new Map<string, Promise<void>>();
  // MEMORY LEAK FIX: Add limits and timeouts to revalidation queue
  private readonly MAX_REVALIDATION_QUEUE_SIZE = 100;
  private readonly REVALIDATION_TIMEOUT_MS = 30000; // 30 seconds

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.enabled = process.env.CACHE_ENABLED !== "false";

    if (!this.enabled) {
      if (process.env.NODE_ENV === "production") {
        logger.error(
          "🚨 [Cache] CRITICAL: Caching disabled in production! " +
            "This will cause severe performance degradation. " +
            "Set CACHE_ENABLED=true and configure Redis credentials.",
        );
      } else {
        logger.warn("[Cache] Caching is disabled via CACHE_ENABLED flag");
      }
      return;
    }

    const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
    const restUrl = process.env.KV_REST_API_URL;
    const restToken = process.env.KV_REST_API_TOKEN;

    if (redisUrl) {
      this.redis = Redis.fromEnv();
      logger.info(
        "[Cache] ✓ Cache client initialized with native Redis protocol",
      );
    } else if (restUrl && restToken) {
      this.redis = new Redis({
        url: restUrl,
        token: restToken,
      });
      logger.info(
        "[Cache] ✓ Cache client initialized with REST API (consider using native protocol)",
      );
    } else {
      if (process.env.NODE_ENV === "production") {
        logger.error(
          "🚨 [Cache] CRITICAL: Missing Redis credentials in production! " +
            "Caching disabled - this will cause severe performance issues. " +
            "Set REDIS_URL or KV_URL for native protocol, or KV_REST_API_URL + KV_REST_API_TOKEN.",
        );
      } else {
        logger.warn("[Cache] Missing Redis credentials, caching disabled.");
      }
      this.enabled = false;
      return;
    }
  }

  /**
   * Gets a value from cache.
   *
   * @param key - Cache key.
   * @returns Cached value or null if not found or invalid.
   */
  async get<T>(key: string): Promise<T | null> {
    this.initialize();
    if (!this.enabled || !this.redis || this.isCircuitOpen()) return null;

    const start = Date.now();
    const value = await this.redis.get<string>(key);
    const duration = Date.now() - start;

    if (value === null || value === undefined) {
      this.logMetric(key, "miss", duration);
      return null;
    }

    // Check for corrupted cache values
    if (typeof value === "string" && value === "[object Object]") {
      logger.warn(
        `[Cache] Corrupted cache value detected for key ${key}, deleting`,
      );
      await this.del(key);
      return null;
    }

    // Parse JSON string back to object
    const parsed: T = typeof value === "string" ? JSON.parse(value) : value;

    if (!this.isValidCacheValue(parsed)) {
      logger.warn(`[Cache] Invalid cached value for key ${key}, deleting`);
      await this.del(key);
      return null;
    }

    this.resetFailures();
    this.logMetric(key, "hit", duration);
    return parsed;
  }

  /**
   * Gets a value from cache with stale-while-revalidate support.
   *
   * Returns stale data immediately if available, then revalidates in the background.
   *
   * @param key - Cache key.
   * @param staleTTL - Time in seconds before data is considered stale.
   * @param revalidate - Function to fetch fresh data.
   * @param ttl - Optional total time to live in seconds. Defaults to staleTTL * 2.
   * @returns Cached value (stale or fresh) or null.
   */
  async getWithSWR<T>(
    key: string,
    staleTTL: number,
    revalidate: () => Promise<T>,
    ttl?: number,
  ): Promise<T | null> {
    const effectiveTTL = ttl ?? staleTTL * 2;
    this.initialize();
    if (!this.enabled || !this.redis || this.isCircuitOpen()) {
      return await revalidate();
    }

    const start = Date.now();
    const value = await this.redis.get<string>(key);
    const duration = Date.now() - start;

    if (value === null || value === undefined) {
      this.logMetric(key, "miss", duration);
      const fresh = await revalidate();
      if (fresh !== null) {
        await this.set(
          key,
          {
            data: fresh,
            cachedAt: Date.now(),
            staleAt: Date.now() + staleTTL * 1000,
          } as CachedValue<T>,
          effectiveTTL,
        );
      }
      return fresh;
    }

    const raw = typeof value === "string" ? JSON.parse(value) : value;
    const parsed = raw as CachedValue<T>;

    const now = Date.now();
    const isStale = now > parsed.staleAt;

    if (isStale) {
      this.logMetric(key, "stale", duration);

      // Return stale data immediately
      const staleData = parsed.data;

      // MEMORY LEAK FIX: Implement queue size limit and timeout
      // Check queue size before adding new revalidation
      if (this.revalidationQueue.size >= this.MAX_REVALIDATION_QUEUE_SIZE) {
        logger.warn(
          `[Cache] Revalidation queue full (${this.revalidationQueue.size}/${this.MAX_REVALIDATION_QUEUE_SIZE}). ` +
            `Skipping background revalidation for key: ${key}`,
        );
        return staleData;
      }

      // Revalidate in background (deduplicated)
      if (!this.revalidationQueue.has(key)) {
        // Create timeout promise
        const timeoutPromise = new Promise<T | null>((_, reject) => {
          setTimeout(
            () => reject(new Error("Revalidation timeout")),
            this.REVALIDATION_TIMEOUT_MS,
          );
        });

        // Race revalidation against timeout
        const revalidationPromise = Promise.race([revalidate(), timeoutPromise])
          .then((fresh) => {
            if (fresh !== null) {
              return this.set(
                key,
                {
                  data: fresh,
                  cachedAt: Date.now(),
                  staleAt: Date.now() + staleTTL * 1000,
                } as CachedValue<T>,
                effectiveTTL,
              );
            }
          })
          .finally(() => {
            this.revalidationQueue.delete(key);
          });

        this.revalidationQueue.set(key, revalidationPromise);
      }

      return staleData;
    }

    this.logMetric(key, "hit", duration);
    this.resetFailures();
    return parsed.data;
  }

  /**
   * Sets a value in cache with TTL.
   *
   * @param key - Cache key.
   * @param value - Value to cache (must be JSON-serializable).
   * @param ttlSeconds - Time to live in seconds.
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.initialize();
    if (!this.enabled || !this.redis || this.isCircuitOpen()) return;

    if (!this.isValidCacheValue(value)) {
      logger.error(`[Cache] Attempted to cache invalid value for key ${key}`);
      return;
    }

    // Always serialize to JSON string before storing
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);

    const start = Date.now();
    await this.redis.setex(key, ttlSeconds, serialized);

    this.resetFailures();
    this.logMetric(key, "set", Date.now() - start);
  }

  /**
   * Deletes a key from cache.
   *
   * @param key - Cache key to delete.
   */
  async del(key: string): Promise<void> {
    this.initialize();
    if (!this.enabled || !this.redis) return;

    const start = Date.now();
    await this.redis.del(key);

    logger.debug(`[Cache] DEL: ${key}`);
    this.logMetric(key, "del", Date.now() - start);
  }

  /**
   * Delete all keys matching a pattern using SCAN (non-blocking)
   *
   * Uses SCAN instead of KEYS to avoid blocking Redis on large keysets
   * See ANALYTICS_PR_REVIEW_ANALYSIS.md - Issue #7 (Fixed)
   *
   * SECURITY FIX: Added max iterations limit to prevent infinite loops
   *
   * @param pattern - Pattern to match (e.g., "org:*:cache")
   * @param batchSize - Number of keys to scan per iteration (default: 100)
   * @param maxIterations - Maximum iterations to prevent runaway scans (default: 1000)
   */
  async delPattern(
    pattern: string,
    batchSize = 100,
    maxIterations = 1000,
  ): Promise<void> {
    this.initialize();
    if (!this.enabled || !this.redis) return;

    const start = Date.now();
    let cursor: string | number = 0;
    let totalDeleted = 0;
    let iterations = 0;

    do {
      // PERFORMANCE FIX: Limit iterations to prevent unbounded scans
      if (iterations >= maxIterations) {
        logger.warn(
          `[Cache] DEL_PATTERN reached max iterations (${maxIterations}) for pattern ${pattern}. ` +
            `Deleted ${totalDeleted} keys so far. Pattern may match too many keys. Consider narrowing the pattern.`,
        );
        break;
      }

      // Use SCAN instead of KEYS to avoid blocking Redis
      const result: [string | number, string[]] = await this.redis.scan(
        cursor,
        {
          match: pattern,
          count: batchSize,
        },
      );

      // result is [nextCursor, keys]
      // Upstash Redis returns cursor as string or number
      cursor =
        typeof result[0] === "string"
          ? Number.parseInt(result[0], 10)
          : result[0];
      const keys = result[1];

      if (keys.length > 0) {
        await this.redis.del(...keys);
        totalDeleted += keys.length;
        logger.debug(
          `[Cache] DEL_PATTERN iteration ${++iterations}: deleted ${keys.length} keys (total: ${totalDeleted})`,
        );
      }

      // Small delay to avoid overwhelming Redis
      if (cursor !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } while (cursor !== 0 && iterations < maxIterations);

    const duration = Date.now() - start;

    if (totalDeleted === 0) {
      logger.debug(`[Cache] DEL_PATTERN: ${pattern} (no keys found)`);
    } else {
      logger.info(
        `[Cache] DEL_PATTERN: ${pattern} (deleted ${totalDeleted} keys in ${duration}ms, ${iterations} iterations)`,
      );
    }

    this.logMetric(pattern, "del_pattern", duration);
  }

  /**
   * Gets multiple values from cache in a single operation.
   *
   * @param keys - Array of cache keys.
   * @returns Array of cached values (null for misses).
   */
  async mget<T>(keys: string[]): Promise<Array<T | null>> {
    this.initialize();
    if (!this.enabled || !this.redis) return keys.map(() => null);

    const start = Date.now();
    const values = await this.redis.mget<string[]>(...keys);

    // Parse each JSON string value
    const parsed = await Promise.all(
      values.map(async (value, index) => {
        if (value === null || value === undefined) return null;

        // Check for corrupted values
        if (typeof value === "string" && value === "[object Object]") {
          logger.warn(
            `[Cache] Corrupted cache value in mget for key ${keys[index]}, skipping`,
          );
          await this.del(keys[index]);
          return null;
        }

        return typeof value === "string" ? JSON.parse(value) : value;
      }),
    );

    const hitCount = parsed.filter((v) => v !== null).length;
    logger.debug(`[Cache] MGET: ${keys.length} keys (${hitCount} hits)`);
    this.logMetric("mget", "hit", Date.now() - start, {
      keys: keys.length,
      hits: hitCount,
    });

    return parsed;
  }

  private isCircuitOpen(): boolean {
    if (this.failureCount < this.MAX_FAILURES) {
      return false;
    }

    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    if (timeSinceLastFailure > this.CIRCUIT_BREAKER_TIMEOUT) {
      logger.info(
        "[Cache] Circuit breaker timeout expired, attempting to reconnect",
      );
      this.failureCount = 0;
      return false;
    }

    logger.warn(
      `[Cache] Circuit breaker OPEN (${this.failureCount} failures, retry in ${Math.ceil((this.CIRCUIT_BREAKER_TIMEOUT - timeSinceLastFailure) / 1000)}s)`,
    );
    return true;
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount === this.MAX_FAILURES) {
      logger.error(
        `[Cache] Circuit breaker OPENED after ${this.MAX_FAILURES} failures`,
      );
    }
  }

  private resetFailures(): void {
    if (this.failureCount > 0) {
      logger.info("[Cache] Circuit breaker CLOSED - cache operational");
      this.failureCount = 0;
    }
  }

  private isValidCacheValue<T>(value: T): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === "string" && value === "[object Object]") {
      return false;
    }

    if (typeof value === "object") {
      try {
        JSON.stringify(value);
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }

  private logMetric(
    _key: string,
    _operation: "hit" | "miss" | "set" | "del" | "del_pattern" | "stale",
    _durationMs: number,
    _metadata?: Record<string, unknown>,
  ): void {
    // Metrics logging disabled to reduce console noise
  }
}

export const cache = new CacheClient();
