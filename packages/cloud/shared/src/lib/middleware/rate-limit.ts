/**
 * Rate Limiting Middleware
 * Implements multiple rate limiting strategies for API protection
 *
 * PRODUCTION: Uses Redis-backed rate limiting when REDIS_RATE_LIMITING=true
 * DEVELOPMENT: Falls back to in-memory storage when Redis is unavailable
 *
 * @see lib/middleware/rate-limit-redis.ts for distributed implementation
 * @see ANALYTICS_PR_REVIEW_ANALYSIS.md - Issue #1 (Fixed)
 */

import type { RouteParams } from "../api/hono-next-style-params";
import { isHotPathCachesEnabled } from "../services/inference-hot-path-caches";
import type { EndpointType, OrgRateLimitConfig } from "../services/org-rate-limits";
import { getOrgRpmForEndpoint } from "../services/org-rate-limits";
import { logger } from "../utils/logger";
import { getRequestCookie } from "../utils/request-cookie";
import { checkRateLimitRedis, type RateLimitResult } from "./rate-limit-redis";

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyGenerator?: (request: Request) => string; // Custom key generator
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store for rate limiting (FALLBACK ONLY)
// ⚠️  WARNING: This implementation uses in-memory storage and will NOT work correctly
// in multi-instance deployments. Each instance will have its own rate limit counter,
// allowing users to bypass limits by hitting different instances.
//
// ✅  FIXED: Redis-backed rate limiting is now available via REDIS_RATE_LIMITING=true
// This in-memory store is kept as a fallback for local development.
//
// PRODUCTION: Always set REDIS_RATE_LIMITING=true
const rateLimitStore = new Map<string, RateLimitEntry>();

// Validate rate limiting configuration on startup
let hasValidatedConfig = false;
function validateRateLimitConfig() {
  if (hasValidatedConfig) return;
  hasValidatedConfig = true;

  // Note: RATE_LIMIT_DISABLED=true skips this startup validation warning only;
  // actual rate limiting is still enforced. Use RATE_LIMIT_MULTIPLIER=1000 to
  // effectively bypass limits in development (replaces the old dev-mode behavior).
  if (process.env.RATE_LIMIT_DISABLED === "true" && process.env.NODE_ENV !== "production") {
    return;
  }

  if (process.env.NODE_ENV === "production") {
    if (process.env.REDIS_RATE_LIMITING !== "true") {
      // ⚠️  IMPORTANT: On a single-server VPS, in-memory rate limiting is safe
      // because there is only one process. Multi-instance/serverless deployments
      // SHOULD configure Redis so limits are shared across instances.
      // We log a warning here instead of throwing so the first API call does not
      // fail with HTTP 500 (the original bug: hasValidatedConfig was set to true
      // BEFORE the throw, causing the first request to 500 and subsequent ones
      // to succeed — masking the misconfiguration while breaking UX).
      logger.warn(
        "[Rate Limit] ⚠️  In-memory rate limiting in production. " +
          "For multi-instance deployments set REDIS_RATE_LIMITING=true and configure Redis. " +
          "Single-server deployments are unaffected.",
      );
    } else {
      logger.info("[Rate Limit] ✓ Using Redis-backed rate limiting (production mode)");
    }
  } else {
    logger.info(
      "[Rate Limit] Development mode: same numeric limits as production; storage is in-memory (set REDIS_RATE_LIMITING=true to use Redis).",
    );
  }
}

/**
 * Clean up expired entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean every minute

/**
 * Mask sensitive keys for logging (never log full API keys)
 */
function maskKeyForLogging(key: string): string {
  if (key.startsWith("apikey:")) {
    const apiKey = key.slice(7);
    // Show prefix and last 4 chars only: apikey:eliza_****d458
    if (apiKey.length > 10) {
      return `apikey:${apiKey.slice(0, 6)}****${apiKey.slice(-4)}`;
    }
    return "apikey:****";
  }
  if (key.startsWith("anon:") && key.length > 12) {
    return `anon:${key.slice(5, 9)}****${key.slice(-4)}`;
  }
  return key;
}

/**
 * Generate rate limit key from request
 */
function getIpKey(request: Request): string {
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return `ip:${ip}`;
}

function getDefaultKey(request: Request): string {
  // Prefer stable, non-IP identifiers.
  //
  // - API key (server-to-server)
  // - authenticated user id (set by middleware on protected routes)
  // - anonymous session token (cookie or header)
  //
  // NOTE: We intentionally do NOT fall back to IP-based keys.
  const apiKey =
    request.headers.get("x-api-key") ||
    request.headers.get("X-API-Key") ||
    (() => {
      const auth = request.headers.get("authorization");
      if (!auth?.startsWith("Bearer ")) return null;
      const token = auth.slice(7);
      // Only treat "eliza_*" bearer tokens as API keys (matches proxy middleware behavior).
      return token.startsWith("eliza_") ? token : null;
    })();

  if (apiKey) return `apikey:${apiKey}`;

  const anonSession =
    request.headers.get("x-anonymous-session") ||
    request.headers.get("X-Anonymous-Session") ||
    getRequestCookie(request, "eliza-anon-session") ||
    null;
  if (anonSession) return `anon:${anonSession}`;

  // If we truly can't identify the caller, use a shared bucket (still not IP-based).
  return "public";
}

/**
 * Check rate limit for a request (synchronous, in-memory only)
 * Internal fallback for development mode.
 */
function checkRateLimit(
  request: Request,
  config: RateLimitConfig,
): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
} {
  validateRateLimitConfig();

  const keyGenerator = config.keyGenerator || getDefaultKey;
  const key = keyGenerator(request);
  const now = Date.now();

  let entry = rateLimitStore.get(key);

  // Create new entry if doesn't exist or expired
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + config.windowMs,
    };
    rateLimitStore.set(key, entry);
  }

  // Increment count
  entry.count++;

  const allowed = entry.count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - entry.count);
  const retryAfter = allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000);

  if (!allowed) {
    logger.warn("Rate limit exceeded", {
      key: maskKeyForLogging(key),
      count: entry.count,
      max: config.maxRequests,
      resetAt: new Date(entry.resetAt).toISOString(),
    });
  }

  return {
    allowed,
    remaining,
    resetAt: entry.resetAt,
    retryAfter,
  };
}

/**
 * Async rate limit check that uses Redis when REDIS_RATE_LIMITING=true
 * Falls back to in-memory for development. Use this for streaming endpoints.
 */
export async function checkRateLimitAsync(
  request: Request,
  config: RateLimitConfig,
): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}> {
  const useRedis = process.env.REDIS_RATE_LIMITING === "true";
  const keyGenerator = config.keyGenerator || getDefaultKey;
  const key = keyGenerator(request);

  if (useRedis) {
    const result = await checkRateLimitRedis(key, config.windowMs, config.maxRequests);
    logger.debug(
      `[Rate Limit] Redis check for key=${maskKeyForLogging(key)}, allowed=${result.allowed}, remaining=${result.remaining}`,
    );
    return result;
  }

  const result = checkRateLimit(request, config);
  logger.debug(
    `[Rate Limit] In-memory check for key=${maskKeyForLogging(key)}, allowed=${result.allowed}, remaining=${result.remaining}`,
  );
  return result;
}

/**
 * 100 requests / 60s per org — shared numeric policy for MCP integration routes, core MCP, and A2A org limits.
 * Keys are still namespaced per surface (`mcp:ratelimit:…`, `a2a:…`) so limits do not collide.
 */
export const ORGANIZATION_SERVICE_BURST_LIMIT = {
  windowMs: 60_000,
  maxRequests: 100,
} as const;

export function rateLimitExceededPayload(
  result: RateLimitResult,
  maxRequests: number,
  windowMs: number,
  policy: "redis" | "in-memory",
): {
  body: {
    success: false;
    error: string;
    code: "rate_limit_exceeded";
    message: string;
    retryAfter?: number;
  };
  headers: Record<string, string>;
} {
  const body = {
    success: false as const,
    error: "Too many requests",
    code: "rate_limit_exceeded" as const,
    message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${Math.ceil(windowMs / 1000)} seconds.`,
    retryAfter: result.retryAfter,
  };
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": maxRequests.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": new Date(result.resetAt).toISOString(),
    "X-RateLimit-Policy": policy,
    "Retry-After": result.retryAfter?.toString() || "60",
  };
  return { body, headers };
}

/** Native `Response` for handlers that avoid duplicated JSON serialization helpers. */
export function rateLimitExceededResponse(
  result: RateLimitResult,
  maxRequests: number,
  windowMs: number,
  policy: "redis" | "in-memory",
): Response {
  const { body, headers } = rateLimitExceededPayload(result, maxRequests, windowMs, policy);
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status: 429, headers: h });
}

export function mcpOrgRateLimitRedisKey(organizationId: string, integrationSlug?: string): string {
  return integrationSlug
    ? `mcp:ratelimit:${integrationSlug}:${organizationId}`
    : `mcp:ratelimit:${organizationId}`;
}

/**
 * Redis org burst limit for MCP surfaces. Returns a 429 `Response` when denied, or `null` when allowed.
 */
export async function enforceMcpOrganizationRateLimit(
  organizationId: string,
  integrationSlug?: string,
): Promise<Response | null> {
  const { windowMs, maxRequests } = ORGANIZATION_SERVICE_BURST_LIMIT;
  const key = mcpOrgRateLimitRedisKey(organizationId, integrationSlug);
  const result = await checkRateLimitRedis(key, windowMs, maxRequests);
  if (result.allowed) return null;
  return rateLimitExceededResponse(result, maxRequests, windowMs, "redis");
}

/**
 * #9899 Tier-3: in-isolate decision lease for `enforceOrgRateLimit`, gated
 * behind `INFERENCE_HOT_PATH_CACHES` (default OFF — flag off is byte-identical
 * to the un-leased path). On CF Workers the authoritative check costs a
 * per-request Redis client build + a TCP/TLS connect + a pipeline (plus a
 * cache read for the org tier) — ~100-400ms of the measured inference warm
 * floor. The lease serves repeat decisions for the same (org, endpoint) from
 * isolate memory, bounded by a local budget, and falls back to the
 * authoritative check the moment the budget is spent or the lease expires.
 *
 * CONVERGENT, not lossy: every leased request is counted. `localUsed` is
 * carried into the NEXT authoritative check (`checkRateLimitRedis`'s
 * `carriedCount` appends them to the sliding window before counting), and the
 * carry survives lease expiry — entries are only replaced when their count has
 * been handed to Redis. So a hot isolate can exceed the org limit by at most
 * ONE in-flight lease budget (min(remaining, the org's pro-rated window share
 * per TTL)) before the window catches up and denies; sustained throughput
 * converges to the org limit. Residual: a carry is lost if the isolate dies
 * (bounded ≤ one budget) or if Redis fails open on the flush (limits are
 * fail-open then anyway). Denials are leased too, which stops a limited org
 * from re-hammering Redis until the lease expires.
 */
const ORG_RATE_LIMIT_LEASE_TTL_MS = 5_000;
const ORG_RATE_LIMIT_LEASE_MAX_KEYS = 4096;

interface OrgRateLimitLease {
  config: OrgRateLimitConfig;
  result: RateLimitResult;
  /**
   * Requests this isolate served off the lease since the last Redis check.
   * NOT dropped at expiry — flushed to Redis as `carriedCount` on the next
   * authoritative check so the window converges to the true count.
   */
  localUsed: number;
  /** Local allowance: min(remaining, pro-rated share of the window per TTL). */
  localBudget: number;
  expiresAt: number;
}

// A plain Map (not the TTL LRU): expiry must NOT delete an entry, because its
// localUsed is the pending carry that keeps the Redis window honest.
const orgRateLimitLeases = new Map<string, OrgRateLimitLease>();

function evictSettledLeases(now: number): void {
  if (orgRateLimitLeases.size < ORG_RATE_LIMIT_LEASE_MAX_KEYS) return;
  for (const [key, lease] of orgRateLimitLeases) {
    // Only entries with nothing left to flush are safe to drop.
    if (lease.expiresAt <= now && lease.localUsed === 0) {
      orgRateLimitLeases.delete(key);
    }
  }
}

/** Test hook: reset the org rate-limit decision leases between tests. */
export function __clearOrgRateLimitLeases(): void {
  orgRateLimitLeases.clear();
}

/**
 * Per-org tier-based rate limit. Returns a 429 `Response` when denied, or `null` when allowed.
 * Call INSIDE the handler AFTER auth — same pattern as enforceMcpOrganizationRateLimit.
 */
export async function enforceOrgRateLimit(
  organizationId: string,
  endpointType: EndpointType,
): Promise<Response | null> {
  // Mirror withRateLimit: skip when Redis is not configured (dev/staging)
  if (process.env.REDIS_RATE_LIMITING !== "true") return null;

  const leaseEnabled = isHotPathCachesEnabled();
  const leaseKey = `${organizationId}:${endpointType}`;
  const now = Date.now();
  // Read the lease even when the flag is off: a flag flip must still flush any
  // pending carry into the window instead of orphaning it.
  const lease = orgRateLimitLeases.get(leaseKey);

  if (leaseEnabled && lease && lease.expiresAt > now) {
    if (!lease.result.allowed) {
      return rateLimitExceededResponse(
        lease.result,
        lease.config.maxRequests,
        lease.config.windowMs,
        "redis",
      );
    }
    if (lease.localUsed < lease.localBudget) {
      lease.localUsed++;
      return null;
    }
    // Local budget spent — fall through to the authoritative check, which
    // flushes localUsed into the window before deciding.
  }

  const config = await getOrgRpmForEndpoint(organizationId, endpointType);
  const { windowMs, maxRequests } = config;
  const key = `org:${organizationId}:${endpointType}`;
  const carriedCount = lease?.localUsed ?? 0;
  const result = await checkRateLimitRedis(key, windowMs, maxRequests, { carriedCount });
  if (leaseEnabled) {
    evictSettledLeases(now);
    orgRateLimitLeases.set(leaseKey, {
      config,
      result,
      localUsed: 0,
      localBudget: Math.min(
        result.remaining,
        Math.ceil((maxRequests * ORG_RATE_LIMIT_LEASE_TTL_MS) / windowMs),
      ),
      expiresAt: now + ORG_RATE_LIMIT_LEASE_TTL_MS,
    });
  } else if (lease) {
    // Flag flipped off: the carry above was just flushed — drop the entry.
    orgRateLimitLeases.delete(leaseKey);
  }
  if (result.allowed) return null;
  return rateLimitExceededResponse(result, maxRequests, windowMs, "redis");
}

/**
 * Rate limit middleware wrapper for API routes
 * Compatible with Next.js 15 where params is a Promise
 * Supports both Response and Response return types
 *
 * Uses Redis-backed rate limiting when REDIS_RATE_LIMITING=true (production)
 * Falls back to in-memory rate limiting for local development
 */
type StaticRouteHandler = (request: Request) => Promise<Response>;
type DynamicRouteHandler<T extends Record<string, string | string[]>> = (
  request: Request,
  context: RouteParams<T>,
) => Promise<Response>;

export function withRateLimit(
  handler: StaticRouteHandler,
  config: RateLimitConfig,
): StaticRouteHandler;
export function withRateLimit<T extends Record<string, string | string[]> = Record<string, string>>(
  handler: DynamicRouteHandler<T>,
  config: RateLimitConfig,
): DynamicRouteHandler<T>;
export function withRateLimit<T extends Record<string, string | string[]> = Record<string, string>>(
  handler: StaticRouteHandler | DynamicRouteHandler<T>,
  config: RateLimitConfig,
) {
  return async (request: Request, context?: RouteParams<T>): Promise<Response> => {
    const useRedis = process.env.REDIS_RATE_LIMITING === "true";
    const keyGenerator = config.keyGenerator || getDefaultKey;
    const key = keyGenerator(request);

    let result;
    if (useRedis) {
      result = await checkRateLimitRedis(key, config.windowMs, config.maxRequests);
      logger.debug(
        `[Rate Limit] Redis check for key=${maskKeyForLogging(key)}, allowed=${result.allowed}, remaining=${result.remaining}`,
      );
    } else {
      result = checkRateLimit(request, config);
      logger.debug(
        `[Rate Limit] In-memory check for key=${maskKeyForLogging(key)}, allowed=${result.allowed}, remaining=${result.remaining}`,
      );
    }

    // Add rate limit headers
    const headers = {
      "X-RateLimit-Limit": config.maxRequests.toString(),
      "X-RateLimit-Remaining": result.remaining.toString(),
      "X-RateLimit-Reset": new Date(result.resetAt).toISOString(),
      "X-RateLimit-Policy": useRedis ? "redis" : "in-memory",
    };

    if (!result.allowed) {
      logger.warn(
        `[Rate Limit] Request blocked for key=${maskKeyForLogging(key)}, limit=${config.maxRequests}, window=${config.windowMs}ms`,
      );

      const policy: "redis" | "in-memory" = useRedis ? "redis" : "in-memory";
      return rateLimitExceededResponse(result, config.maxRequests, config.windowMs, policy);
    }

    // Call the actual handler
    const response =
      context === undefined
        ? await (handler as StaticRouteHandler)(request)
        : await (handler as DynamicRouteHandler<T>)(request, context);

    // Add rate limit headers to successful responses
    // Create new response with additional headers to preserve immutability
    const newHeaders = new Headers(response.headers);
    for (const [headerKey, value] of Object.entries(headers)) {
      newHeaders.set(headerKey, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}

/**
 * Get rate limit multiplier from environment.
 * Allows local developers to increase limits without code changes.
 * Set RATE_LIMIT_MULTIPLIER=100 in .env.local to effectively disable limits during dev.
 * Default is 1 (production-level limits).
 *
 * NOTE: Multiplier is ignored in production (NODE_ENV=production) to prevent
 * accidental rate limit inflation from leftover staging/dev configuration.
 */
function getRateLimitMultiplier(): number {
  // In production, always enforce strict rate limits (multiplier = 1)
  if (process.env.NODE_ENV === "production") {
    return 1;
  }
  const multiplier = process.env.RATE_LIMIT_MULTIPLIER;
  if (!multiplier) return 1;
  // Use parseInt to match env-validator which only accepts integer strings (/^\d+$/)
  const parsed = Number.parseInt(multiplier, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

/**
 * Preset rate limit configurations (same values in dev and production).
 * Only the backing store differs: Redis when REDIS_RATE_LIMITING=true, else in-memory.
 *
 * NOTE FOR LOCAL DEVELOPMENT: These are production-level limits by default.
 * Set RATE_LIMIT_MULTIPLIER=100 in .env.local to increase limits for local dev/testing.
 */
const rateLimitMultiplier = getRateLimitMultiplier();

export const RateLimitPresets = {
  /** 60 requests per minute - standard API endpoints */
  STANDARD: {
    windowMs: 60000,
    maxRequests: 60 * rateLimitMultiplier,
  },

  /** 10 requests per minute - sensitive operations */
  STRICT: {
    windowMs: 60000,
    maxRequests: 10 * rateLimitMultiplier,
  },

  /** 200 requests per minute - high-throughput endpoints */
  RELAXED: {
    windowMs: 60000,
    maxRequests: 200 * rateLimitMultiplier,
  },

  /** 5 requests per 5 minutes - critical/expensive operations */
  CRITICAL: {
    windowMs: 300000,
    maxRequests: 5 * rateLimitMultiplier,
  },

  /** 10 requests per second - burst protection */
  BURST: {
    windowMs: 1000,
    maxRequests: 10 * rateLimitMultiplier,
  },

  /** 100 requests per minute, keyed by IP - for public endpoints */
  AGGRESSIVE: {
    windowMs: 60000,
    maxRequests: 100 * rateLimitMultiplier,
    keyGenerator: getIpKey,
  },
} as const;

// Freeze presets to prevent accidental mutation of security-critical thresholds
// Note: `as const` makes the type readonly; Object.freeze adds runtime immutability for computed values
Object.freeze(RateLimitPresets);
Object.values(RateLimitPresets).forEach(Object.freeze);

/**
 * Cost-based rate limiting for expensive operations
 */
export interface CostBasedRateLimitConfig {
  windowMs: number;
  maxCost: number; // Maximum total cost in the window
  getCost: (request: Request) => number | Promise<number>;
}

const costLimitStore = new Map<string, { totalCost: number; resetAt: number }>();

/**
 * Check cost-based rate limit
 */
export async function checkCostBasedRateLimit(
  request: Request,
  config: CostBasedRateLimitConfig,
): Promise<{
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}> {
  const key = getDefaultKey(request);
  const now = Date.now();
  const cost = await config.getCost(request);

  let entry = costLimitStore.get(key);

  if (!entry || entry.resetAt < now) {
    entry = {
      totalCost: 0,
      resetAt: now + config.windowMs,
    };
    costLimitStore.set(key, entry);
  }

  entry.totalCost += cost;

  const allowed = entry.totalCost <= config.maxCost;
  const remaining = Math.max(0, config.maxCost - entry.totalCost);
  const retryAfter = allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000);

  if (!allowed) {
    logger.warn("Cost-based rate limit exceeded", {
      key: maskKeyForLogging(key),
      cost,
      totalCost: entry.totalCost,
      maxCost: config.maxCost,
    });
  }

  return {
    allowed,
    remaining,
    retryAfter,
  };
}

/**
 * Clean up cost limit store periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of costLimitStore.entries()) {
    if (entry.resetAt < now) {
      costLimitStore.delete(key);
    }
  }
}, 60000);
