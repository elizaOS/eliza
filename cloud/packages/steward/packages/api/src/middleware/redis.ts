/**
 * Redis middleware — initializes the Redis client and exposes
 * rate-limiting + spend-tracking helpers on the Hono context.
 *
 * When REDIS_URL is not set, the middleware is a no-op and the helpers
 * return permissive defaults so the API still works without Redis.
 */

import {
  checkRateLimit,
  checkSpendLimit,
  disconnectRedis,
  getRedis,
  type IoredisLike,
  type RateLimitResult,
  recordSpend,
  type SpendPeriod,
} from "@stwd/redis";

// ─── Redis availability flag ─────────────────────────────────────────────────

let redisAvailable = false;
let redisClient: IoredisLike | null = null;

/**
 * Try to connect to Redis on startup. If it fails, we degrade gracefully —
 * rate-limit and spend-tracking are skipped (policy engine still works).
 */
export async function initRedis(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("[steward:redis] REDIS_URL not set — Redis enforcement disabled");
    return false;
  }

  try {
    redisClient = getRedis();
    // Ping to verify the connection
    await redisClient?.ping();
    redisAvailable = true;
    console.log("[steward:redis] Redis connected — rate limiting and spend tracking enabled");
    return true;
  } catch (err) {
    console.warn(
      "[steward:redis] Failed to connect — Redis enforcement disabled:",
      (err as Error).message,
    );
    redisAvailable = false;
    return false;
  }
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

/**
 * Return the active Redis client (real ioredis or upstash adapter), or null
 * if Redis is not available. Call isRedisAvailable() first to check.
 */
export function getRedisClient(): IoredisLike | null {
  return redisAvailable ? redisClient : null;
}

export async function shutdownRedis(): Promise<void> {
  if (redisAvailable) {
    await disconnectRedis();
    redisAvailable = false;
    redisClient = null;
  }
}

// ─── Rate-limit helpers (safe wrappers) ──────────────────────────────────────

const PERMISSIVE_RATE_LIMIT: RateLimitResult = {
  allowed: true,
  remaining: Infinity,
  resetMs: 0,
};

/**
 * Check rate limit for an agent's vault signing requests.
 *
 * Key format: ratelimit:vault:{agentId}:{windowMs}
 */
export async function checkAgentRateLimit(
  agentId: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  if (!redisAvailable) return PERMISSIVE_RATE_LIMIT;

  try {
    const key = `ratelimit:vault:${agentId}:${windowMs}`;
    return await checkRateLimit(key, windowMs, maxRequests);
  } catch (err) {
    console.error(
      "[steward:redis] Rate limit check failed, allowing request:",
      (err as Error).message,
    );
    return PERMISSIVE_RATE_LIMIT;
  }
}

/**
 * Check rate limit for proxy requests.
 *
 * Key format: ratelimit:proxy:{agentId}:{host}:{windowMs}
 */
export async function checkProxyRateLimit(
  agentId: string,
  host: string,
  windowMs: number,
  maxRequests: number,
): Promise<RateLimitResult> {
  if (!redisAvailable) return PERMISSIVE_RATE_LIMIT;

  try {
    const key = `ratelimit:proxy:${agentId}:${host}:${windowMs}`;
    return await checkRateLimit(key, windowMs, maxRequests);
  } catch (err) {
    console.error(
      "[steward:redis] Proxy rate limit check failed, allowing request:",
      (err as Error).message,
    );
    return PERMISSIVE_RATE_LIMIT;
  }
}

// ─── Spend-tracking helpers (safe wrappers) ───────────────────────────────────

/**
 * Check if an agent's spending would exceed their limit.
 */
export async function checkAgentSpendLimit(
  agentId: string,
  limitUsd: number,
  period: SpendPeriod,
): Promise<{ allowed: boolean; spent: number; remaining: number }> {
  if (!redisAvailable) return { allowed: true, spent: 0, remaining: limitUsd };

  try {
    return await checkSpendLimit(agentId, limitUsd, period);
  } catch (err) {
    console.error(
      "[steward:redis] Spend limit check failed, allowing request:",
      (err as Error).message,
    );
    return { allowed: true, spent: 0, remaining: limitUsd };
  }
}

/**
 * Record a spend event after a successful transaction/request.
 */
export async function recordAgentSpend(
  agentId: string,
  tenantId: string,
  costUsd: number,
  host: string,
): Promise<void> {
  if (!redisAvailable || costUsd <= 0) return;

  try {
    await recordSpend(agentId, tenantId, costUsd, host);
  } catch (err) {
    console.error("[steward:redis] Failed to record spend:", (err as Error).message);
  }
}

// Re-export cost estimator for proxy use
export { estimateCost } from "@stwd/redis";
