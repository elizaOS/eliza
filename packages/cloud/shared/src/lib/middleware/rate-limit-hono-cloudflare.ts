/**
 * Rate-limit middleware for Hono on Cloudflare Workers.
 *
 * Falls open if Redis is not configured. Adds `X-RateLimit-*` headers on success.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext, AppEnv, Bindings } from "../../types/cloud-worker-env";
import { buildRedisClient, type CompatibleRedis } from "../cache/redis-factory";
import { logger } from "../utils/logger";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: AppContext) => string;
  /**
   * Fail CLOSED on a runtime Redis error. Default (undefined/false) falls open
   * — a Redis outage should not turn ordinary routes into 503s. Set on
   * money/auth routes (session mint, top-up) where losing the limiter is worse
   * than a brief availability hit: if the backing store throws at request time
   * the request is rejected (503) instead of sailing through unlimited.
   */
  failClosed?: boolean;
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

/**
 * Verdict for the production rate-limit config guard (#9853 P1.1). The limiters
 * fall open whenever Redis is unreachable, so production must never silently run
 * with limiting disabled:
 *   - `ok`            — limiting is on and Redis is reachable (or not production).
 *   - `fail-closed`   — prod + REDIS_RATE_LIMITING="true" but no reachable Redis:
 *                       a deploy misconfiguration — reject traffic + alert loudly.
 *   - `warn-disabled` — prod + limiting not enabled: falls open; warn loudly so
 *                       the ops cutover (provision Redis, flip the flag) is visible.
 * Pure (takes a resolved `hasRedisClient`) so it is unit-testable without booting
 * the Worker or a live Redis.
 */
export type RateLimitConfigVerdict = "ok" | "fail-closed" | "warn-disabled";
export function rateLimitConfigVerdict(opts: {
  environment?: string;
  redisRateLimiting?: string;
  hasRedisClient: boolean;
}): RateLimitConfigVerdict {
  if (opts.environment !== "production") return "ok";
  if (opts.redisRateLimiting !== "true") return "warn-disabled";
  return opts.hasRedisClient ? "ok" : "fail-closed";
}

/**
 * Resolve the client IP, preferring `cf-connecting-ip` (set by Cloudflare and
 * not spoofable by the client) over `x-forwarded-for` so a forged XFF header
 * cannot evade IP-keyed limits. Returns `undefined` when no IP is known.
 */
function getRequestIp(c: Context): string | undefined {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    undefined
  );
}

function getIpKey(c: Context): string {
  return `ip:${getRequestIp(c) ?? "unknown"}`;
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

  // Unauthenticated public traffic buckets PER-IP, not a global constant.
  // Returning the literal "public" put ALL anonymous traffic worldwide into one
  // window, so a single flooder (600/min) 429-locked every anonymous client on
  // every route using the default key generator (#11087). Per-IP confines the
  // limit to the abuser. "public" survives only as the last resort when the IP
  // is unresolvable (e.g. a proxy stripped forwarding headers) — still bounded,
  // but no longer the common path.
  const ip = getRequestIp(c);
  return ip ? `ip:${ip}` : "public";
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

export function applyRateLimitMultiplier(config: RateLimitConfig, env: Bindings): RateLimitConfig {
  const m = multiplier(env);
  if (m === 1) return config;
  return {
    ...config,
    maxRequests: config.maxRequests * m,
  };
}

export async function checkUpstash(
  redis: CompatibleRedis,
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<CheckResult> {
  const fullKey = `ratelimit:${key}`;
  const count = await redis.incr(fullKey);
  let ttl = count === 1 ? null : await redis.pttl(fullKey);
  if (count === 1 || ttl === null || ttl < 0) {
    // First request of a window — or an ORPHANED counter: if the pexpire after
    // a previous window's first incr ever failed (Workers sub-request drop),
    // the key has no TTL (pttl -1), so the counter grows forever and the
    // client is permanently 429'd while resetAt/retryAfter keep promising a
    // 60s reset that never happens (observed live: an IP at ~26 req/hour
    // locked out of every endpoint, including public /models). Always re-arm
    // the window here so a missed expiry heals on the next request instead of
    // bricking the key.
    await redis.pexpire(fullKey, windowMs);
    ttl = windowMs;
  }
  const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
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

    const effectiveConfig = applyRateLimitMultiplier(config, env);

    if (
      (env.RATE_LIMIT_DISABLED === "true" || env.PLAYWRIGHT_TEST_AUTH === "true") &&
      env.NODE_ENV !== "production"
    ) {
      await next();
      applyRateLimitHeaders(
        c,
        rateLimitHeaders(effectiveConfig, fallOpenResult(effectiveConfig), "disabled"),
      );
      return;
    }

    const redis = getRedis(env);
    if (!redis) {
      await next();
      applyRateLimitHeaders(
        c,
        rateLimitHeaders(effectiveConfig, fallOpenResult(effectiveConfig), "fall-open"),
      );
      return;
    }

    const key = (config.keyGenerator ?? getDefaultKey)(c);
    let result: CheckResult;
    let policy = "redis";

    try {
      result = await checkUpstash(
        redis,
        key,
        effectiveConfig.windowMs,
        effectiveConfig.maxRequests,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.failClosed) {
        // Money/auth route: losing the limiter is worse than a brief 503, so
        // reject rather than serve unlimited requests while Redis is down.
        logger.error("[RateLimit] Redis unavailable on fail-closed route; rejecting", {
          error: message,
        });
        return c.json(
          {
            success: false,
            error: "Service temporarily unavailable",
            code: "rate_limit_unavailable" as const,
            message: "Rate limiter backing store is unavailable; request rejected.",
          },
          503,
          { "Retry-After": "30" },
        );
      }
      // Rate limiting is protective middleware. If its backing store is down
      // or unreachable in local Worker dev, requests should fall open instead
      // of turning application routes into 500s.
      logger.warn("[RateLimit] Redis unavailable; falling open", {
        error: message,
      });
      result = fallOpenResult(effectiveConfig);
      policy = "redis-unavailable";
    }

    const headers = rateLimitHeaders(effectiveConfig, result, policy);

    if (!result.allowed) {
      return c.json(
        {
          success: false,
          error: "Too many requests",
          code: "rate_limit_exceeded" as const,
          message: `Rate limit exceeded. Maximum ${effectiveConfig.maxRequests} requests per ${Math.ceil(
            effectiveConfig.windowMs / 1000,
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

export { getDefaultKey, getIpKey, getRequestIp };
export const _multiplier = multiplier;
