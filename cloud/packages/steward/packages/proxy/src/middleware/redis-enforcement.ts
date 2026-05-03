/**
 * Redis-backed rate limiting and spend tracking for the proxy gateway.
 *
 * Checks per-agent rate limits before forwarding requests and records
 * API costs after receiving responses (using the cost estimator).
 */

import {
  checkRateLimit,
  checkSpendLimit,
  disconnectRedis,
  estimateCost,
  getRedis,
  isKnownHost,
  type RateLimitResult,
  recordSpend,
} from "@stwd/redis";

// ─── State ───────────────────────────────────────────────────────────────────

let redisAvailable = false;

/**
 * Initialize Redis for the proxy. Non-blocking — proxy works without Redis.
 */
export async function initProxyRedis(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("[proxy:redis] REDIS_URL not set — Redis enforcement disabled");
    return false;
  }

  try {
    const client = getRedis();
    await client.ping();
    redisAvailable = true;
    console.log("[proxy:redis] Redis connected — rate limiting and spend tracking enabled");
    return true;
  } catch (err) {
    console.warn("[proxy:redis] Failed to connect:", (err as Error).message);
    return false;
  }
}

export function isProxyRedisAvailable(): boolean {
  return redisAvailable;
}

export async function shutdownProxyRedis(): Promise<void> {
  if (redisAvailable) {
    await disconnectRedis();
    redisAvailable = false;
  }
}

// ─── Default rate limits for proxy (per-agent per-host) ──────────────────────

const DEFAULT_PROXY_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_PROXY_RATE_LIMIT_MAX = 60; // 60 requests/minute per agent per host

const PERMISSIVE: RateLimitResult = {
  allowed: true,
  remaining: Infinity,
  resetMs: 0,
};

/**
 * Check rate limit for a proxy request.
 * Uses a per-agent, per-host sliding window.
 */
export async function checkProxyRateLimit(
  agentId: string,
  host: string,
  windowMs: number = DEFAULT_PROXY_RATE_LIMIT_WINDOW_MS,
  maxRequests: number = DEFAULT_PROXY_RATE_LIMIT_MAX,
): Promise<RateLimitResult> {
  if (!redisAvailable) return PERMISSIVE;

  try {
    const key = `ratelimit:proxy:${agentId}:${host}:${windowMs}`;
    return await checkRateLimit(key, windowMs, maxRequests);
  } catch (err) {
    console.error("[proxy:redis] Rate limit check failed:", (err as Error).message);
    return PERMISSIVE;
  }
}

/**
 * Estimate and record spend for a proxied API call.
 *
 * Should be called after receiving the upstream response.
 * Only tracks costs for known LLM hosts (OpenAI, Anthropic).
 *
 * @param agentId - The agent making the request
 * @param tenantId - The agent's tenant
 * @param host - The target API host
 * @param requestBody - The parsed request body (for model detection)
 * @param responseBody - The parsed response body (for token usage)
 */
export async function trackProxySpend(
  agentId: string,
  tenantId: string,
  host: string,
  requestBody: any,
  responseBody: any,
): Promise<number> {
  if (!redisAvailable) return 0;
  if (!isKnownHost(host)) return 0;

  try {
    const cost = estimateCost(host, requestBody, responseBody);
    if (cost > 0) {
      await recordSpend(agentId, tenantId, cost, host);
    }
    return cost;
  } catch (err) {
    console.error("[proxy:redis] Spend tracking failed:", (err as Error).message);
    return 0;
  }
}

/**
 * Check if an agent has exceeded their API spend budget.
 *
 * @param agentId - The agent ID
 * @param dailyLimitUsd - Maximum daily spend in USD (0 = no limit)
 */
export async function checkProxySpendLimit(
  agentId: string,
  dailyLimitUsd: number,
): Promise<{ allowed: boolean; spent: number; remaining: number }> {
  if (!redisAvailable || dailyLimitUsd <= 0) {
    return { allowed: true, spent: 0, remaining: dailyLimitUsd };
  }

  try {
    return await checkSpendLimit(agentId, dailyLimitUsd, "day");
  } catch (err) {
    console.error("[proxy:redis] Spend limit check failed:", (err as Error).message);
    return { allowed: true, spent: 0, remaining: dailyLimitUsd };
  }
}
