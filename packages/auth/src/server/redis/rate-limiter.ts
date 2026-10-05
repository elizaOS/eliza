/**
 * Sliding window rate limiter using Redis sorted sets.
 *
 * Uses MULTI/EXEC for atomic check-and-increment.
 * Keys auto-expire after the window passes.
 *
 * Key format: ratelimit:{key}
 * (Caller provides the full key, e.g. ratelimit:{agentId}:{host}:{window})
 */

import { randomUUID } from "node:crypto";
import { getRedis } from "./client.js";

// KEYS[1]=zset  ARGV: now, windowStart, maxRequests, member, ttlMs
// Prune the window, count, and add the member only if strictly under the
// limit (count < max → the Nth request is admitted, N+1 rejected). Done in one
// script so concurrent requests cannot collectively pass the ceiling.
const RATE_LIMIT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[2]))
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[4])
  allowed = 1
  count = count + 1
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local oldestScore = ARGV[1]
if oldest[2] ~= nil then oldestScore = oldest[2] end
return {allowed, count, oldestScore}
`;

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in the current window */
  remaining: number;
  /** Milliseconds until the window resets (oldest entry expires) */
  resetMs: number;
}

function validateRateLimitInput(
  key: string,
  windowMs: number,
  maxRequests: number,
): void {
  if (key.length === 0 || key.length > 512) {
    throw new RangeError(
      "rate limit key must contain between 1 and 512 characters",
    );
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError("rate limit windowMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
    throw new RangeError(
      "rate limit maxRequests must be a positive safe integer",
    );
  }
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
  validateRateLimitInput(key, windowMs, maxRequests);
  const redis = getRedis();
  const now = Date.now();
  const windowStart = now - windowMs;

  // Unique member: timestamp + random suffix to handle sub-ms bursts
  const member = `${now}:${randomUUID()}`;

  const res = (await redis.eval(
    RATE_LIMIT_LUA,
    1,
    key,
    String(now),
    String(windowStart),
    String(maxRequests),
    member,
    String(windowMs + 1000), // TTL = window + 1s buffer
  )) as [number, number, string];
  const [allowed, count, oldestScore] = res;

  const oldestTimestamp = oldestScore != null ? Number(oldestScore) : now;
  const resetMs = Math.max(0, oldestTimestamp + windowMs - now);

  if (allowed !== 1) {
    return { allowed: false, remaining: 0, resetMs };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - count),
    resetMs,
  };
}

/**
 * Get current rate limit status without incrementing.
 *
 * ADVISORY ONLY: `allowed` (count < maxRequests) mirrors the atomic gate's
 * admit condition but does not itself reserve a slot — enforcement is
 * checkRateLimit. Use this for display, not as the gate.
 */
export async function getRateLimitStatus(
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  validateRateLimitInput(key, windowMs, maxRequests);
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
