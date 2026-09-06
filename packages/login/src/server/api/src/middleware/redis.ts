/**
 * Redis middleware — initializes the Redis client and exposes
 * rate-limiting + spend-tracking helpers on the Hono context.
 *
 * When Redis is not configured, the middleware is a no-op and the helpers
 * return documented local-development defaults. If Redis is configured and a
 * money-path/rate-limit helper cannot read it, the helper fails closed.
 */

import { logger } from "@elizaos/logger";
import {
  checkRateLimit,
  checkSpendLimit,
  disconnectRedis,
  getRedis,
  type IoredisLike,
  type RateLimitResult,
  recordSpend,
  type SpendPeriod,
} from "../../../redis/src/index.ts";
import { redactedThrownDiagnostics } from "../../../shared/src/index.ts";

// ─── Redis availability flag ─────────────────────────────────────────────────

let redisAvailable = false;
let redisClient: IoredisLike | null = null;

/**
 * Try to connect to Redis on startup. If it fails, route-level helpers decide
 * whether to use local-development defaults or fail closed based on whether
 * Redis was configured for this deployment.
 */
export async function initRedis(
  env?: Record<string, unknown>,
): Promise<boolean> {
  if (redisAvailable && redisClient) return true;

  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
    }
  }

  const driver = process.env.REDIS_DRIVER?.trim().toLowerCase() || "ioredis";
  const hasIoredisUrl = Boolean(process.env.REDIS_URL);
  const hasUpstashConfig = Boolean(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
  );

  if (driver === "upstash" ? !hasUpstashConfig : !hasIoredisUrl) {
    const expected =
      driver === "upstash" ? "KV_REST_API_URL/KV_REST_API_TOKEN" : "REDIS_URL";
    logger.info(
      {
        details: [
          `[steward:redis] ${expected} not set — Redis enforcement disabled`,
        ],
      },
      "[Login:redis] info",
    );
    return false;
  }

  try {
    redisClient = getRedis();
    // Ping to verify the connection
    await redisClient?.ping();
    redisAvailable = true;
    logger.info(
      {
        details: [
          "[steward:redis] Redis connected — rate limiting and spend tracking enabled",
        ],
      },
      "[Login:redis] info",
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        details: [
          "[steward:redis] Failed to connect — Redis enforcement disabled",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:redis] warn",
    );
    redisAvailable = false;
    return false;
  }
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export function isRedisConfigured(): boolean {
  const driver = process.env.REDIS_DRIVER?.trim().toLowerCase() || "ioredis";
  if (driver === "upstash") {
    return Boolean(
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
        (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
    );
  }
  return Boolean(process.env.REDIS_URL);
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
  // Redis not available: only skip enforcement when Redis was never configured
  // (documented dev path). If Redis IS configured (production), an unavailable
  // backend must fail CLOSED — mirroring checkAgentSpendLimit (SEC-016).
  if (!redisAvailable) {
    if (!isRedisConfigured()) return PERMISSIVE_RATE_LIMIT;
    return { allowed: false, remaining: 0, resetMs: 60_000 };
  }

  try {
    const key = `ratelimit:vault:${agentId}:${windowMs}`;
    return await checkRateLimit(key, windowMs, maxRequests);
  } catch (err) {
    logger.error(
      {
        details: [
          "[steward:redis] Rate limit check failed, denying sensitive request",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:redis] error",
    );
    return { allowed: false, remaining: 0, resetMs: 60_000 };
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
  // Same fail-closed posture as checkAgentRateLimit (SEC-016): permissive only
  // when Redis was never configured; a configured-but-down backend denies.
  if (!redisAvailable) {
    if (!isRedisConfigured()) return PERMISSIVE_RATE_LIMIT;
    return { allowed: false, remaining: 0, resetMs: 60_000 };
  }

  try {
    const key = `ratelimit:proxy:${agentId}:${host}:${windowMs}`;
    return await checkRateLimit(key, windowMs, maxRequests);
  } catch (err) {
    logger.error(
      {
        details: [
          "[steward:redis] Proxy rate limit check failed, denying request",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:redis] error",
    );
    return { allowed: false, remaining: 0, resetMs: 60_000 };
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
  // Redis not available: only skip enforcement when Redis was never configured
  // (documented dev path). If Redis IS configured (production), an unavailable
  // backend must fail CLOSED rather than silently allow unlimited spend.
  if (!redisAvailable) {
    if (!isRedisConfigured())
      return { allowed: true, spent: 0, remaining: limitUsd };
    return { allowed: false, spent: 0, remaining: 0 };
  }

  try {
    return await checkSpendLimit(agentId, limitUsd, period);
  } catch (err) {
    // Configured backend threw: fail CLOSED — we cannot prove the spend is within limit.
    logger.error(
      {
        details: [
          "[steward:redis] Spend limit check failed, denying request (fail-closed)",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:redis] error",
    );
    return { allowed: false, spent: 0, remaining: 0 };
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
    logger.error(
      {
        details: [
          "[steward:redis] Failed to record spend",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:redis] error",
    );
  }
}

// Re-export cost estimator for proxy use
