/**
 * Rate-limit middleware for Hono on Cloudflare Workers.
 *
 * Protective hot paths may use Cloudflare's machine-local Rate Limiting
 * binding. Other routes use Redis and fall open if it is not configured.
 * Routes that must stay available during a Redis outage can install an
 * explicit per-isolate fallback bucket; every other sensitive route either
 * fails closed or falls open according to its config.
 */

import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AppContext, AppEnv, Bindings } from "../../types/cloud-worker-env";
import { buildRedisClient, type CompatibleRedis } from "../cache/redis-factory";
import { isHotPathCachesEnabled } from "../services/inference-hot-path-caches";
import { logger } from "../utils/logger";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (c: AppContext) => string;
  /**
   * Use an in-isolate fallback bucket when Redis throws at request time.
   * This is weaker than the shared Redis limiter because every Worker isolate
   * has its own map, but it keeps low-risk login/session paths throttled during
   * a Redis outage instead of choosing between total outage and unlimited
   * fail-open traffic. Keep money/payment routes on `failClosed` without this.
   */
  redisUnavailableFallback?: {
    namespace: string;
    windowMs?: number;
    maxRequests?: number;
  };
  /**
   * Fail CLOSED on a runtime Redis error. Default (undefined/false) falls open
   * — a Redis outage should not turn ordinary routes into 503s. Set on
   * sensitive routes where losing every limiter is worse than a brief
   * availability hit: if the backing store throws at request time the request
   * is rejected (503) instead of sailing through unlimited. Auth/session routes
   * that install `redisUnavailableFallback` stay available but locally bounded.
   */
  failClosed?: boolean;
}

/** Cloudflare's machine-local Rate Limiting binding. */
export interface CloudflareRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface CloudflareRateLimitOptions {
  /** Name of the Wrangler Rate Limiting binding in `c.env`. */
  bindingName: string;
}

/** Optional construction dependencies for hosts that manage Redis lifecycle externally. */
export interface RateLimitDependencies {
  buildRedisClient?: (env: Bindings) => CompatibleRedis | null;
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

function hashRateLimitIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  if (apiKey) return `apikey:${hashRateLimitIdentifier(apiKey)}`;

  const userId = c.get("user")?.id;
  if (userId) return `user:${userId}`;

  const anon =
    c.req.header("x-anonymous-session") ||
    c.req.header("X-Anonymous-Session") ||
    c.req.header("cookie")?.match(/eliza-anon-session=([^;]+)/)?.[1] ||
    null;
  if (anon) return `anon:${hashRateLimitIdentifier(anon)}`;

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

function isCloudflareRateLimitBinding(value: unknown): value is CloudflareRateLimitBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "limit" in value &&
    typeof value.limit === "function"
  );
}

function nativeRateLimitHeaders(config: RateLimitConfig) {
  return {
    "X-RateLimit-Limit": String(config.maxRequests),
    "X-RateLimit-Policy": "cloudflare-native",
  };
}

function nativeRateLimitUnavailable(c: Context, bindingName: string): Response {
  logger.error("[RateLimit] Required Cloudflare Rate Limiting binding unavailable", {
    bindingName,
  });
  return c.json(
    {
      success: false,
      error: "Service temporarily unavailable",
      code: "rate_limit_unavailable" as const,
      message: "Rate limiter binding is unavailable; request rejected.",
    },
    503,
    { "Retry-After": "30" },
  );
}

interface LocalFallbackBucket {
  count: number;
  resetAt: number;
}

const redisUnavailableFallbackBuckets = new Map<string, LocalFallbackBucket>();

const HONO_RATE_LIMIT_LEASE_TTL_MS = 5_000;
const HONO_RATE_LIMIT_LEASE_MAX_KEYS = 4096;

interface HonoRateLimitLease {
  result: CheckResult;
  localUsed: number;
  localBudget: number;
  expiresAt: number;
  flushToken?: symbol;
}

const honoRateLimitLeases = new Map<string, HonoRateLimitLease>();

function honoLeaseKey(key: string, config: RateLimitConfig): string {
  return `${key}:${config.windowMs}:${config.maxRequests}`;
}

function evictSettledHonoLeases(now: number): void {
  if (honoRateLimitLeases.size < HONO_RATE_LIMIT_LEASE_MAX_KEYS) return;
  for (const [key, lease] of honoRateLimitLeases) {
    if (lease.expiresAt <= now && lease.localUsed === 0) {
      honoRateLimitLeases.delete(key);
    }
  }
}

function startHonoLeaseFlush(leaseKey: string): {
  lease?: HonoRateLimitLease;
  carriedCount: number;
  flushToken: symbol;
  ownsLeaseFlush: boolean;
} {
  const lease = honoRateLimitLeases.get(leaseKey);
  const flushToken = Symbol(leaseKey);
  if (!lease || lease.flushToken) {
    return { lease, carriedCount: 0, flushToken, ownsLeaseFlush: false };
  }
  const carriedCount = lease.localUsed;
  lease.localUsed = 0;
  lease.flushToken = flushToken;
  return { lease, carriedCount, flushToken, ownsLeaseFlush: true };
}

function restoreHonoLeaseCarry(
  lease: HonoRateLimitLease | undefined,
  flushToken: symbol,
  carriedCount: number,
): void {
  if (!lease || lease.flushToken !== flushToken) return;
  lease.localUsed += carriedCount;
  lease.flushToken = undefined;
}

function publishHonoLease(opts: {
  leaseKey: string;
  lease?: HonoRateLimitLease;
  flushToken: symbol;
  ownsLeaseFlush: boolean;
  result: CheckResult;
  config: RateLimitConfig;
  now: number;
  enabled: boolean;
}): void {
  const { leaseKey, lease, flushToken, ownsLeaseFlush, result, config, now, enabled } = opts;
  if (!enabled) {
    if (lease && ownsLeaseFlush && lease.flushToken === flushToken) {
      honoRateLimitLeases.delete(leaseKey);
    }
    return;
  }

  evictSettledHonoLeases(now);
  const currentLease = honoRateLimitLeases.get(leaseKey);
  if (!lease || (ownsLeaseFlush && currentLease === lease && lease.flushToken === flushToken)) {
    honoRateLimitLeases.set(leaseKey, {
      result,
      localUsed: lease && currentLease === lease ? lease.localUsed : 0,
      localBudget: Math.min(
        result.remaining,
        Math.ceil((config.maxRequests * HONO_RATE_LIMIT_LEASE_TTL_MS) / config.windowMs),
      ),
      expiresAt: now + HONO_RATE_LIMIT_LEASE_TTL_MS,
    });
  }
}

function resolvedFallbackConfig(
  config: RateLimitConfig,
): { namespace: string; windowMs: number; maxRequests: number } | null {
  const fallback = config.redisUnavailableFallback;
  if (!fallback) return null;
  return {
    namespace: fallback.namespace,
    windowMs: fallback.windowMs ?? config.windowMs,
    maxRequests: fallback.maxRequests ?? config.maxRequests,
  };
}

function fallbackHeadersConfig(config: RateLimitConfig): RateLimitConfig {
  const fallback = resolvedFallbackConfig(config);
  if (!fallback) return config;
  return {
    ...config,
    windowMs: fallback.windowMs,
    maxRequests: fallback.maxRequests,
  };
}

function checkRedisUnavailableFallback(
  key: string,
  config: RateLimitConfig,
  now = Date.now(),
): CheckResult {
  const fallback = resolvedFallbackConfig(config);
  if (!fallback) return fallOpenResult(config);
  const bucketKey = `${fallback.namespace}:${key}`;
  const current = redisUnavailableFallbackBuckets.get(bucketKey);
  const bucket =
    current && current.resetAt > now ? current : { count: 0, resetAt: now + fallback.windowMs };
  bucket.count += 1;
  redisUnavailableFallbackBuckets.set(bucketKey, bucket);
  const allowed = bucket.count <= fallback.maxRequests;
  return {
    allowed,
    remaining: Math.max(0, fallback.maxRequests - bucket.count),
    resetAt: bucket.resetAt,
    retryAfter: allowed ? undefined : Math.ceil((bucket.resetAt - now) / 1000),
  };
}

function applyRateLimitHeaders(c: Context, headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    // Hono middleware unwinds from the innermost route back to the outermost
    // middleware. Preserve a more specific inner limiter's response metadata
    // instead of replacing (for example) a 200/min chat limit with the outer
    // 600/min global limit.
    if (!c.res.headers.has(k)) {
      c.res.headers.set(k, v);
    }
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
  options?: { carriedCount?: number },
): Promise<CheckResult> {
  const fullKey = `ratelimit:${key}`;
  const carriedCount = Math.max(0, Math.floor(options?.carriedCount ?? 0));

  // A lease flush may carry dozens of locally-served requests. Sending one
  // TCP round-trip per carried request turns the first request after a quiet
  // period into an N-second stall. Redis pipelines preserve the exact count
  // while flushing every increment and the TTL read in one network exchange.
  const pipeline = redis.pipeline();
  for (let i = 0; i < carriedCount; i++) {
    pipeline.incr(fullKey);
  }
  pipeline.incr(fullKey);
  pipeline.pttl(fullKey);
  const results = await pipeline.exec();
  const count = Number(results[carriedCount] ?? 0);
  let ttl = Number(results[carriedCount + 1] ?? -1);
  if (count === 1 || !Number.isFinite(ttl) || ttl < 0) {
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

export function rateLimit(
  config: RateLimitConfig,
  cloudflare?: CloudflareRateLimitOptions,
  dependencies?: RateLimitDependencies,
): MiddlewareHandler<AppEnv> {
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

    if (cloudflare) {
      const binding = env[cloudflare.bindingName];
      if (isCloudflareRateLimitBinding(binding)) {
        const key = (config.keyGenerator ?? getDefaultKey)(c);
        let success: boolean | undefined;
        try {
          ({ success } = await binding.limit({ key }));
        } catch (error) {
          // error-policy:J1 middleware boundary translates a platform binding failure into a visible 503.
          logger.error("[RateLimit] Cloudflare Rate Limiting binding failed", {
            bindingName: cloudflare.bindingName,
            error: error instanceof Error ? error.message : String(error),
          });
          if (env.NODE_ENV === "production") {
            return nativeRateLimitUnavailable(c, cloudflare.bindingName);
          }
        }

        if (success === false) {
          const headers = nativeRateLimitHeaders(effectiveConfig);
          return c.json(
            {
              success: false,
              error: "Too many requests",
              code: "rate_limit_exceeded" as const,
              message: `Rate limit exceeded. Maximum ${effectiveConfig.maxRequests} requests per ${Math.ceil(
                effectiveConfig.windowMs / 1000,
              )} seconds.`,
              retryAfter: Math.ceil(effectiveConfig.windowMs / 1000),
            },
            429,
            {
              ...headers,
              "Retry-After": String(Math.ceil(effectiveConfig.windowMs / 1000)),
            },
          );
        }

        if (success === true) {
          await next();
          applyRateLimitHeaders(c, nativeRateLimitHeaders(effectiveConfig));
          return;
        }
      }

      if (env.NODE_ENV === "production") {
        return nativeRateLimitUnavailable(c, cloudflare.bindingName);
      }
    }

    const redis = dependencies?.buildRedisClient
      ? dependencies.buildRedisClient(env)
      : getRedis(env);
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
    let headersConfig = effectiveConfig;
    const leaseEnabled = isHotPathCachesEnabled(env);
    const leaseKey = honoLeaseKey(key, effectiveConfig);
    const now = Date.now();
    const lease = honoRateLimitLeases.get(leaseKey);

    if (leaseEnabled && lease && lease.expiresAt > now) {
      if (!lease.result.allowed) {
        result = lease.result;
        const headers = rateLimitHeaders(headersConfig, result, "redis-lease");
        return c.json(
          {
            success: false,
            error: "Too many requests",
            code: "rate_limit_exceeded" as const,
            message: `Rate limit exceeded. Maximum ${headersConfig.maxRequests} requests per ${Math.ceil(
              headersConfig.windowMs / 1000,
            )} seconds.`,
            retryAfter: result.retryAfter,
          },
          429,
          { ...headers, "Retry-After": String(result.retryAfter ?? 60) },
        );
      }
      if (!lease.flushToken && lease.localUsed < lease.localBudget) {
        lease.localUsed++;
        await next();
        applyRateLimitHeaders(c, rateLimitHeaders(headersConfig, lease.result, "redis-lease"));
        return;
      }
    }

    const flush = startHonoLeaseFlush(leaseKey);

    try {
      result = await checkUpstash(
        redis,
        key,
        effectiveConfig.windowMs,
        effectiveConfig.maxRequests,
        { carriedCount: flush.carriedCount },
      );
      publishHonoLease({
        leaseKey,
        lease: flush.lease,
        flushToken: flush.flushToken,
        ownsLeaseFlush: flush.ownsLeaseFlush,
        result,
        config: effectiveConfig,
        now,
        enabled: leaseEnabled,
      });
    } catch (error) {
      restoreHonoLeaseCarry(flush.lease, flush.flushToken, flush.carriedCount);
      const message = error instanceof Error ? error.message : String(error);
      if (effectiveConfig.redisUnavailableFallback) {
        logger.warn("[RateLimit] Redis unavailable; using local fallback limiter", {
          error: message,
        });
        result = checkRedisUnavailableFallback(key, effectiveConfig);
        headersConfig = fallbackHeadersConfig(effectiveConfig);
        policy = "redis-unavailable-local";
      } else if (config.failClosed) {
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
      } else {
        // Rate limiting is protective middleware. If its backing store is down
        // or unreachable in local Worker dev, requests should fall open instead
        // of turning application routes into 500s.
        logger.warn("[RateLimit] Redis unavailable; falling open", {
          error: message,
        });
        result = fallOpenResult(effectiveConfig);
        policy = "redis-unavailable";
      }
    }

    const headers = rateLimitHeaders(headersConfig, result, policy);

    if (!result.allowed) {
      return c.json(
        {
          success: false,
          error: "Too many requests",
          code: "rate_limit_exceeded" as const,
          message: `Rate limit exceeded. Maximum ${headersConfig.maxRequests} requests per ${Math.ceil(
            headersConfig.windowMs / 1000,
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
export const _resetRedisUnavailableFallbackBuckets = () => redisUnavailableFallbackBuckets.clear();
export const _resetHonoRateLimitLeases = () => honoRateLimitLeases.clear();
