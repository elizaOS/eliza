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

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimitRedis } from "./rate-limit-redis";
import { logger } from "@/lib/utils/logger";

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyGenerator?: (request: NextRequest) => string; // Custom key generator
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

  if (process.env.NODE_ENV === "production") {
    if (process.env.REDIS_RATE_LIMITING !== "true") {
      throw new Error(
        "🚨 SECURITY: Redis rate limiting is required in production. " +
          "In-memory rate limiting allows bypass across serverless instances. " +
          "Set REDIS_RATE_LIMITING=true and configure Redis connection.",
      );
    }
    logger.info(
      "[Rate Limit] ✓ Using Redis-backed rate limiting (production mode)",
    );
  } else {
    logger.info(
      "[Rate Limit] 🔓 Development mode: Rate limits relaxed (10000 req/window)",
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
function getIpKey(request: NextRequest): string {
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return `ip:${ip}`;
}

function getDefaultKey(request: NextRequest): string {
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

  const privyUserId = request.headers.get("x-privy-user-id");
  if (privyUserId) return `user:${privyUserId}`;

  const anonSession =
    request.headers.get("x-anonymous-session") ||
    request.headers.get("X-Anonymous-Session") ||
    request.cookies.get("eliza-anon-session")?.value ||
    null;
  if (anonSession) return `anon:${anonSession}`;

  // If we truly can't identify the caller, use a shared bucket (still not IP-based).
  return "public";
}

/**
 * Check rate limit for a request (synchronous, in-memory only)
 * @deprecated Use checkRateLimitAsync for production multi-instance deployments
 */
export function checkRateLimit(
  request: NextRequest,
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
  const retryAfter = allowed
    ? undefined
    : Math.ceil((entry.resetAt - now) / 1000);

  if (!allowed) {
    console.warn("Rate limit exceeded", {
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
  request: NextRequest,
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
    const result = await checkRateLimitRedis(
      key,
      config.windowMs,
      config.maxRequests,
    );
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
 * Rate limit middleware wrapper for API routes
 * Compatible with Next.js 15 where params is a Promise
 * Supports both NextResponse and Response return types
 *
 * Uses Redis-backed rate limiting when REDIS_RATE_LIMITING=true (production)
 * Falls back to in-memory rate limiting for local development
 */
export function withRateLimit<T = Record<string, string>>(
  handler: (
    request: NextRequest,
    context?: { params: Promise<T> },
  ) => Promise<Response>,
  config: RateLimitConfig,
) {
  return async (
    request: NextRequest,
    context?: { params: Promise<T> },
  ): Promise<Response> => {
    const useRedis = process.env.REDIS_RATE_LIMITING === "true";
    const keyGenerator = config.keyGenerator || getDefaultKey;
    const key = keyGenerator(request);

    let result;
    if (useRedis) {
      result = await checkRateLimitRedis(
        key,
        config.windowMs,
        config.maxRequests,
      );
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

      return NextResponse.json(
        {
          success: false,
          error: "Too many requests",
          message: `Rate limit exceeded. Maximum ${config.maxRequests} requests per ${Math.ceil(config.windowMs / 1000)} seconds.`,
          retryAfter: result.retryAfter,
        },
        {
          status: 429,
          headers: {
            ...headers,
            "Retry-After": result.retryAfter?.toString() || "60",
          },
        },
      );
    }

    // Call the actual handler
    const response = await handler(request, context);

    // Add rate limit headers to successful responses
    // Create new response with additional headers to preserve immutability
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) {
      newHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}

/**
 * Preset rate limit configurations
 * DEVELOPMENT: Very high limits to allow rapid testing and iteration
 * PRODUCTION: Strict limits to protect against abuse
 */
const isDevelopment = process.env.NODE_ENV !== "production";

export const RateLimitPresets = {
  // Generous limits for general API usage
  STANDARD: {
    windowMs: 60000, // 1 minute
    maxRequests: isDevelopment ? 10000 : 60, // Dev: virtually unlimited, Prod: 60/min
  },

  // Strict limits for expensive operations
  STRICT: {
    windowMs: 60000, // 1 minute
    maxRequests: isDevelopment ? 10000 : 10, // Dev: virtually unlimited, Prod: 10/min
  },

  // Very strict for critical operations (deployments, payments)
  CRITICAL: {
    windowMs: 300000, // 5 minutes
    maxRequests: isDevelopment ? 10000 : 5, // Dev: virtually unlimited, Prod: 5/5min
  },

  // Burst allowance for real-time features
  BURST: {
    windowMs: 1000, // 1 second
    maxRequests: isDevelopment ? 1000 : 10, // Dev: 1000/sec, Prod: 10/sec
  },

  // Aggressive limits for webhook endpoints (external services calling us)
  // Webhooks are server-to-server and should be rate limited per IP
  // 100/min is reasonable for payment provider callbacks
  AGGRESSIVE: {
    windowMs: 60000, // 1 minute
    maxRequests: isDevelopment ? 10000 : 100, // Dev: virtually unlimited, Prod: 100/min
    keyGenerator: getIpKey,
  },
} as const;

/**
 * Cost-based rate limiting for expensive operations
 */
export interface CostBasedRateLimitConfig {
  windowMs: number;
  maxCost: number; // Maximum total cost in the window
  getCost: (request: NextRequest) => number | Promise<number>;
}

const costLimitStore = new Map<
  string,
  { totalCost: number; resetAt: number }
>();

/**
 * Check cost-based rate limit
 */
export async function checkCostBasedRateLimit(
  request: NextRequest,
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
  const retryAfter = allowed
    ? undefined
    : Math.ceil((entry.resetAt - now) / 1000);

  if (!allowed) {
    console.warn("Cost-based rate limit exceeded", {
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
