/**
 * Sliding window rate limiter using Redis sorted sets.
 *
 * Uses MULTI/EXEC for atomic check-and-increment.
 * Keys auto-expire after the window passes.
 *
 * Key format: ratelimit:{key}
 * (Caller provides the full key, e.g. ratelimit:{agentId}:{host}:{window})
 */

import { getRedis } from "./client.js";

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in the current window */
  remaining: number;
  /** Milliseconds until the window resets (oldest entry expires) */
  resetMs: number;
}

/**
 * Check and increment a sliding window rate limit.
 *
 * Uses a sorted set where:
 * - Score = timestamp (ms)
 * - Member = unique request ID (timestamp + random suffix to avoid collisions)
 *
 * The window slides: we remove all entries older than (now - windowMs),
 * then count remaining entries to determine if under the limit.
 *
 * @param key - Rate limit key (e.g. "ratelimit:agent-123:api.openai.com:60000")
 * @param windowMs - Window size in milliseconds
 * @param maxRequests - Maximum requests allowed in the window
 */
export async function checkRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - windowMs;

  // Unique member: timestamp + random suffix to handle sub-ms bursts
  const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

  // Atomic pipeline:
  // 1. Remove entries outside the window
  // 2. Add the new entry
  // 3. Count entries in the window
  // 4. Get the oldest entry (for reset time)
  // 5. Set TTL on the key
  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, windowStart); // 1. prune old
  pipeline.zadd(key, now, member); // 2. add new
  pipeline.zcard(key); // 3. count
  pipeline.zrange(key, 0, 0, "WITHSCORES"); // 4. oldest entry
  pipeline.pexpire(key, windowMs + 1000); // 5. TTL = window + 1s buffer

  const results = await pipeline.exec();
  if (!results) {
    throw new Error("Redis MULTI/EXEC returned null (transaction aborted)");
  }

  // results[2] = [null, count]
  const currentCount = results[2]?.[1] as number;

  // results[3] = [null, [member, score]] or [null, []]
  const oldestEntry = results[3]?.[1] as string[];
  const oldestTimestamp = oldestEntry.length >= 2 ? Number(oldestEntry[1]) : now;
  const resetMs = Math.max(0, oldestTimestamp + windowMs - now);

  if (currentCount > maxRequests) {
    // Over limit — remove the entry we just added (we were speculative)
    await redis.zrem(key, member);
    return {
      allowed: false,
      remaining: 0,
      resetMs,
    };
  }

  return {
    allowed: true,
    remaining: maxRequests - currentCount,
    resetMs,
  };
}

/**
 * Get current rate limit status without incrementing.
 */
export async function getRateLimitStatus(
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - windowMs;

  // Clean up and count
  await redis.zremrangebyscore(key, 0, windowStart);
  const [count, oldest] = await Promise.all([
    redis.zcard(key),
    redis.zrange(key, 0, 0, "WITHSCORES"),
  ]);

  const oldestTimestamp = oldest.length >= 2 ? Number(oldest[1]) : now;
  const resetMs = Math.max(0, oldestTimestamp + windowMs - now);

  return {
    allowed: count < maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetMs,
  };
}
