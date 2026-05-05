/**
 * Rate-limit middleware for Hono on Cloudflare Workers.
 *
 * Falls open if Redis is not configured. Adds `X-RateLimit-*` headers on success.
 */

import type { Context, MiddlewareHandler } from "hono";

import { buildRedisClient, type CompatibleRedis } from "@/lib/cache/redis-factory";
import type { AppContext, AppEnv, Bindings } from "@/types/cloud-worker-env";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: AppContext) => string;
}

function getRedis(env: Bindings): CompatibleRedis | null {
  if (
    env.REDIS_RATE_LIMITING === "false" ||
    (env.CACHE_ENABLED === "false" && env.NODE_ENV !== "production")
  ) {
    return null;
  }

  return buildRedisClient(env);
}

function getIpKey(c: Context): string {
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return `ip:${ip}`;
}

function getDefaultKey(c: AppContext): string {
  const apiKey =
    c.req.header("x-api-key") ||
    c.req.header("X-API-Key") ||
    (() => {
      const auth = c.req.header("authorization");
      if (!auth?.startsWith("Bearer ")) return null;
      const token = auth.slice(7);
      return token.startsWith("eliza_") ? token : null;
    })();
  if (apiKey) return `apikey:${apiKey}`;

  const userId = c.get("user")?.id;
  if (userId) return `user:${userId}`;

  const anon =
    c.req.header("x-anonymous-session") ||
    c.req.header("X-Anonymous-Session") ||
    c.req.header("cookie")?.match(/eliza-anon-session=([^;]+)/)?.[1] ||
    null;
  if (anon) return `anon:${anon}`;

  return "public";
}

interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

function rateLimitHeaders(config: RateLimitConfig, result: CheckResult, policy: string) {
  return {
    "X-RateLimit-Limit": String(config.maxRequests),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": new Date(result.resetAt).toISOString(),
    "X-RateLimit-Policy": policy,
  };
}

function fallOpenResult(config: RateLimitConfig): CheckResult {
  return {
    allowed: true,
    remaining: config.maxRequests,
    resetAt: Date.now() + config.windowMs,
  };
}

function applyRateLimitHeaders(c: Context, headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    c.res.headers.set(k, v);
  }
}

async function checkUpstash(
  redis: CompatibleRedis,
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<CheckResult> {
  const fullKey = `ratelimit:${key}`;
  const count = await redis.incr(fullKey);
  if (count === 1) {
    await redis.pexpire(fullKey, windowMs);
  }
  const ttl = await redis.pttl(fullKey);
  const resetAt = Date.now() + (ttl !== null && ttl > 0 ? ttl : windowMs);
  const allowed = count <= maxRequests;
  return {
    allowed,
    remaining: Math.max(0, maxRequests - count),
    resetAt,
    retryAfter: allowed ? undefined : Math.ceil((resetAt - Date.now()) / 1000),
  };
}

export function rateLimit(config: RateLimitConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = (c.env ?? {}) as Bindings;

    // Outside Cloudflare Workers (e.g. unit tests) c.env is undefined — skip rate limiting.
    if (!env) {
      await next();
      return;
    }

    if (
      (env.RATE_LIMIT_DISABLED === "true" || env.PLAYWRIGHT_TEST_AUTH === "true") &&
      env.NODE_ENV !== "production"
    ) {
      await next();
      applyRateLimitHeaders(c, rateLimitHeaders(config, fallOpenResult(config), "disabled"));
      return;
    }

    const redis = getRedis(env);
    if (!redis) {
      await next();
      applyRateLimitHeaders(c, rateLimitHeaders(config, fallOpenResult(config), "fall-open"));
      return;
    }

    const key = (config.keyGenerator ?? getDefaultKey)(c);
    let result: CheckResult;
    let policy = "redis";

    try {
      result = await checkUpstash(redis, key, config.windowMs, config.maxRequests);
    } catch (error) {
      // Rate limiting is protective middleware. If its backing store is down
      // or unreachable in local Worker dev, requests should fall open instead
      // of turning application routes into 500s.
      console.warn("[RateLimit] Redis unavailable; falling open", {
        error: error instanceof Error ? error.message : String(error),
      });
      result = fallOpenResult(config);
      policy = "redis-unavailable";
    }

    const headers = rateLimitHeaders(config, result, policy);

    if (!result.allowed) {
      return c.json(
        {
          success: false,
          error: "Too many requests",
          code: "rate_limit_exceeded" as const,
          message: `Rate limit exceeded. Maximum ${config.maxRequests} requests per ${Math.ceil(
            config.windowMs / 1000,
          )} seconds.`,
          retryAfter: result.retryAfter,
        },
        429,
        { ...headers, "Retry-After": String(result.retryAfter ?? 60) },
      );
    }

    await next();

    applyRateLimitHeaders(c, headers);
  };
}

function multiplier(env: Bindings): number {
  if (env.NODE_ENV === "production") return 1;
  const raw = env.RATE_LIMIT_MULTIPLIER;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

export const RateLimitPresets = {
  STANDARD: { windowMs: 60_000, maxRequests: 60 },
  STRICT: { windowMs: 60_000, maxRequests: 10 },
  RELAXED: { windowMs: 60_000, maxRequests: 200 },
  CRITICAL: { windowMs: 300_000, maxRequests: 5 },
  BURST: { windowMs: 1_000, maxRequests: 10 },
  AGGRESSIVE: { windowMs: 60_000, maxRequests: 100, keyGenerator: getIpKey },
} as const;

export { getDefaultKey, getIpKey };
export const _multiplier = multiplier;
