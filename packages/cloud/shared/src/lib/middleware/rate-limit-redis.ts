/**
 * Redis-Backed Rate Limiting
 *
 * This module implements distributed rate limiting using Upstash Redis
 * to ensure rate limits work correctly across multiple serverless instances.
 *
 * Algorithm: Sliding Window using Redis Sorted Sets
 * - Each request is stored as a member in a sorted set with timestamp as score
 * - Old entries are removed before counting
 * - Atomic operations via Redis pipeline ensure consistency
 *
 * @see ANALYTICS_PR_REVIEW_ANALYSIS.md - Issue #1
 */

import {
  buildRedisClient,
  type CompatibleRedis,
  isCloudflareWorkerRuntime,
} from "../cache/redis-factory";
import { logger } from "../utils/logger";

/** Environment prefix — prevents rate-limit key collisions when dev/prod share the same Redis instance. */
const ENV_PREFIX = process.env.ENVIRONMENT || "local";

let cachedRedis: CompatibleRedis | null = null;
let loggedInit = false;
let loggedMissing = false;

function getRedisClient(): CompatibleRedis | null {
  // On Workers the client is built PER CALL: a cached TCP socket belongs to
  // the request that opened it and every later request fails with "Cannot
  // perform I/O on behalf of a different request" (observed on the prod
  // inference routes). Node keeps the persistent connection.
  if (!isCloudflareWorkerRuntime() && cachedRedis) return cachedRedis;

  const client = buildRedisClient();
  if (!client) {
    if (!loggedMissing) {
      loggedMissing = true;
      logger.error(
        "[Rate Limit Redis] Missing Redis credentials. Set REDIS_URL or KV_REST_API_URL/KV_REST_API_TOKEN",
      );
    }
    return null;
  }

  if (!loggedInit) {
    loggedInit = true;
    logger.info("[Rate Limit Redis] Redis client initialized");
  }
  if (!isCloudflareWorkerRuntime()) cachedRedis = client;
  return client;
}

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * Check rate limit using Redis with sliding window algorithm
 *
 * @param key - Unique identifier for the rate limit (e.g., user ID, API key, IP)
 * @param windowMs - Time window in milliseconds
 * @param maxRequests - Maximum requests allowed in the window
 * @returns Rate limit result with allowed status and metadata
 *
 * @example
 * ```typescript
 * const result = await checkRateLimitRedis("user:123", 60000, 60);
 * if (!result.allowed) {
 *   return res.status(429).json({ error: "Too many requests" });
 * }
 * ```
 */
export async function checkRateLimitRedis(
  key: string,
  windowMs: number,
  maxRequests: number,
  options?: {
    /**
     * Requests already SERVED locally since the last authoritative check
     * (#9899 Tier-3 in-isolate decision lease). They are appended to the
     * sliding window here — BEFORE the count — so Redis converges to the true
     * request count and a lease can never make the window under-count by more
     * than the one in-flight local budget. Scored at `now`, which errs strict:
     * they happened up to a lease-TTL ago, so they stay counted slightly
     * longer than a live append would have.
     */
    carriedCount?: number;
  },
): Promise<RateLimitResult> {
  const client = getRedisClient();

  if (!client) {
    logger.warn("[Rate Limit Redis] Redis unavailable, failing open (allowing request)");
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: Date.now() + windowMs,
    };
  }

  const now = Date.now();
  const windowStart = now - windowMs;
  const cacheKey = `${ENV_PREFIX}:ratelimit:${key}`;
  const carriedCount = Math.max(0, Math.floor(options?.carriedCount ?? 0));

  try {
    const pipeline = client.pipeline();

    pipeline.zremrangebyscore(cacheKey, 0, windowStart);

    // Backfill locally-served (leased) requests before the count so they gate
    // this decision like any other member of the window.
    for (let i = 0; i < carriedCount; i++) {
      pipeline.zadd(cacheKey, {
        score: now,
        member: `${now}-carry${i}-${Math.random().toString(36).substring(7)}`,
      });
    }

    pipeline.zcard(cacheKey);

    pipeline.zadd(cacheKey, {
      score: now,
      member: `${now}-${Math.random().toString(36).substring(7)}`,
    });

    pipeline.expire(cacheKey, Math.ceil(windowMs / 1000) + 10);

    const results = await pipeline.exec();

    const count = ((results[1 + carriedCount] as number) || 0) as number;

    const allowed = count < maxRequests;
    const remaining = Math.max(0, maxRequests - count - 1);
    const resetAt = now + windowMs;
    const retryAfter = allowed ? undefined : Math.ceil(windowMs / 1000);

    if (!allowed) {
      logger.info(
        `[Rate Limit Redis] Limit exceeded for key=${key}, count=${count + 1}, max=${maxRequests}`,
      );
    } else {
      logger.debug(`[Rate Limit Redis] Request allowed for key=${key}, remaining=${remaining}`);
    }

    return {
      allowed,
      remaining,
      resetAt,
      retryAfter,
    };
  } catch (error) {
    logger.error("[Rate Limit Redis] Error checking rate limit:", error);
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: now + windowMs,
    };
  }
}

/**
 * Clear rate limit for a specific key (useful for testing or admin actions)
 */
/**
 * Clears rate limit for a specific key.
 *
 * Useful for testing or admin actions.
 *
 * @param key - Rate limit key to clear.
 */
export async function clearRateLimit(key: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.del(`${ENV_PREFIX}:ratelimit:${key}`);
    logger.info(`[Rate Limit Redis] Cleared rate limit for key=${key}`);
  } catch (error) {
    logger.error(`[Rate Limit Redis] Error clearing rate limit:`, error);
  }
}

/**
 * Get current rate limit status without incrementing counter
 */
/**
 * Gets current rate limit status without incrementing counter.
 *
 * @param key - Rate limit key.
 * @param windowMs - Time window in milliseconds.
 * @param maxRequests - Maximum requests allowed.
 * @returns Current rate limit status.
 */
export async function getRateLimitStatus(
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<{ count: number; remaining: number; resetAt: number }> {
  const client = getRedisClient();

  if (!client) {
    return {
      count: 0,
      remaining: maxRequests,
      resetAt: Date.now() + windowMs,
    };
  }

  const now = Date.now();
  const windowStart = now - windowMs;
  const cacheKey = `${ENV_PREFIX}:ratelimit:${key}`;

  try {
    await client.zremrangebyscore(cacheKey, 0, windowStart);

    const count = await client.zcard(cacheKey);

    return {
      count,
      remaining: Math.max(0, maxRequests - count),
      resetAt: now + windowMs,
    };
  } catch (error) {
    logger.error("[Rate Limit Redis] Error getting status:", error);
    return {
      count: 0,
      remaining: maxRequests,
      resetAt: now + windowMs,
    };
  }
}
