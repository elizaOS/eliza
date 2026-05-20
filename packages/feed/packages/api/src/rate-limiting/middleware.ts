/**
 * Rate Limiting Middleware for Next.js API Routes
 *
 * Provides helpers to apply rate limiting and duplicate detection to API routes
 */

import type { AuthenticatedUser } from "@feed/shared";
import { logger } from "@feed/shared";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { optionalAuth } from "../auth-middleware";
import {
  checkDuplicate,
  type DUPLICATE_DETECTION_CONFIGS,
} from "../utils/duplicate-detector";
import { getClientIp } from "../utils/ip-utils";
import {
  checkRateLimit,
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
} from "./user-rate-limiter";

function isRateLimitingDisabled() {
  return (
    process.env.DISABLE_RATE_LIMITING === "true" &&
    (process.env.NODE_ENV !== "production" ||
      process.env.ALLOW_TEST_PRIVY_DID_AUTH === "true")
  );
}

/**
 * Error response for rate limit exceeded
 */
export function rateLimitError(retryAfter?: number) {
  const response = NextResponse.json(
    {
      success: false,
      error: "Rate limit exceeded",
      message: `Too many requests. Please try again ${retryAfter ? `in ${retryAfter} seconds` : "later"}.`,
      retryAfter,
    },
    { status: 429 },
  );

  // Add standard rate limit headers
  if (retryAfter) {
    response.headers.set("Retry-After", retryAfter.toString());
  }
  response.headers.set("X-RateLimit-Exceeded", "true");

  return response;
}

/**
 * Error response for duplicate content
 */
export function duplicateContentError(lastPostedAt?: Date) {
  return NextResponse.json(
    {
      success: false,
      error: "Duplicate content",
      message:
        "You have already posted this content recently. Please wait before posting it again.",
      lastPostedAt: lastPostedAt?.toISOString(),
    },
    { status: 409 }, // 409 Conflict
  );
}

/**
 * Apply rate limiting to an API route handler
 *
 * Usage:
 * ```ts
 * export async function POST(request: NextRequest) {
 *   const user = await authenticate(request);
 *
 *   const rateLimitResult = await applyRateLimit(user.userId, RATE_LIMIT_CONFIGS.CREATE_POST);
 *   if (!rateLimitResult.allowed) {
 *     return rateLimitError(rateLimitResult.retryAfter);
 *   }
 *
 *   // ... rest of handler
 * }
 * ```
 */
export function applyRateLimit(
  userId: string,
  config: (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS],
) {
  if (isRateLimitingDisabled()) {
    return {
      allowed: true,
      remaining: config.maxRequests,
    };
  }

  return checkRateLimit(userId, config);
}

/**
 * Apply duplicate detection to content
 *
 * Usage:
 * ```ts
 * const duplicateResult = await applyDuplicateDetection(
 *   user.userId,
 *   content,
 *   DUPLICATE_DETECTION_CONFIGS.POST
 * );
 * if (duplicateResult.isDuplicate) {
 *   return duplicateContentError(duplicateResult.lastPostedAt);
 * }
 * ```
 */
export function applyDuplicateDetection(
  userId: string,
  content: string,
  config: (typeof DUPLICATE_DETECTION_CONFIGS)[keyof typeof DUPLICATE_DETECTION_CONFIGS],
) {
  return checkDuplicate(userId, content, config);
}

/**
 * Combined rate limiting and duplicate detection
 * Returns a NextResponse if either check fails, or null if both pass
 *
 * Usage:
 * ```ts
 * const errorResponse = await checkRateLimitAndDuplicates(
 *   user.userId,
 *   content,
 *   RATE_LIMIT_CONFIGS.CREATE_POST,
 *   DUPLICATE_DETECTION_CONFIGS.POST
 * );
 * if (errorResponse) return errorResponse;
 * ```
 */
export function checkRateLimitAndDuplicates(
  userId: string,
  content: string | null,
  rateLimitConfig: (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS],
  duplicateConfig?: (typeof DUPLICATE_DETECTION_CONFIGS)[keyof typeof DUPLICATE_DETECTION_CONFIGS],
): NextResponse | null {
  if (isRateLimitingDisabled()) {
    return null;
  }

  // Check rate limit first
  const rateLimitResult = checkRateLimit(userId, rateLimitConfig);
  if (!rateLimitResult.allowed) {
    logger.warn("Rate limit check failed", {
      userId,
      actionType: rateLimitConfig.actionType,
      retryAfter: rateLimitResult.retryAfter,
    });
    return rateLimitError(rateLimitResult.retryAfter);
  }

  // Check for duplicates if content is provided and config is given
  if (content && duplicateConfig) {
    const duplicateResult = checkDuplicate(userId, content, duplicateConfig);
    if (duplicateResult.isDuplicate) {
      logger.warn("Duplicate content detected", {
        userId,
        actionType: duplicateConfig.actionType,
        lastPostedAt: duplicateResult.lastPostedAt?.toISOString(),
      });
      return duplicateContentError(duplicateResult.lastPostedAt);
    }
  }

  // All checks passed
  logger.debug("Rate limit and duplicate checks passed", {
    userId,
    actionType: rateLimitConfig.actionType,
    remaining: rateLimitResult.remaining,
  });

  return null;
}

/**
 * Add rate limit headers to a response
 */
export function addRateLimitHeaders(
  response: NextResponse,
  remaining: number,
  resetAt: Date,
): NextResponse {
  response.headers.set("X-RateLimit-Remaining", remaining.toString());
  response.headers.set("X-RateLimit-Reset", resetAt.toISOString());
  return response;
}

/**
 * Add public read rate limit and cache headers to a response.
 * Call after publicRateLimit() when returning a successful response.
 *
 * WHY these headers:
 * - X-RateLimit-*: Clients can back off before hitting 429 and show "retry after"
 *   in UX. Reset time is in ISO format for consistency with other APIs.
 * - Cache-Control: public read responses are cacheable by CDNs; short s-maxage
 *   (5s) plus stale-while-revalidate (10s) reduces origin load while keeping
 *   data reasonably fresh.
 */
export function addPublicReadHeaders(
  response: NextResponse,
  rateLimitInfo: {
    limit: number;
    remaining: number;
    resetAt: Date;
  },
): NextResponse {
  response.headers.set("X-RateLimit-Limit", rateLimitInfo.limit.toString());
  response.headers.set(
    "X-RateLimit-Remaining",
    rateLimitInfo.remaining.toString(),
  );
  response.headers.set(
    "X-RateLimit-Reset",
    rateLimitInfo.resetAt.toISOString(),
  );
  response.headers.set(
    "Cache-Control",
    "public, s-maxage=5, stale-while-revalidate=10",
  );
  return response;
}

/** Options for public rate limit: 'read' for GET endpoints, 'firehose' for SSE token/connection limits. */
export type PublicRateLimitKind = "read" | "firehose";

/**
 * Result of publicRateLimit. Use `user` in the handler to avoid calling optionalAuth() again;
 * use `rateLimitInfo` with addPublicReadHeaders() on success so clients get limit and cache headers.
 */
export interface PublicRateLimitResult {
  error: NextResponse | null;
  user: AuthenticatedUser | null;
  /** When allowed; pass to addPublicReadHeaders() so response includes X-RateLimit-* and Cache-Control. */
  rateLimitInfo?: {
    limit: number;
    remaining: number;
    resetAt: Date;
  };
}

/**
 * Tiered rate limit for public read-only endpoints.
 *
 * WHY tiered: Unauthenticated traffic is capped per IP (or shared bucket when IP
 * is unknown) to limit abuse and cost; authenticated users and API keys get higher
 * limits because they are identifiable and we want to support legitimate clients.
 *
 * Key choice:
 * - If request has valid token or API key → key = userId, use authed config (60/min read, 20/min firehose).
 * - Else if we have a client IP → key = IP, use public config (20/min read, 5/min firehose).
 * - Else → key = "anonymous", use strict shared config (10/min read, 2/min firehose) so we still
 *   limit load when e.g. behind proxies that strip forwarded headers.
 *
 * Returns error response (429) if limited; otherwise { error: null, user, rateLimitInfo } so
 * the handler can use `user` instead of calling optionalAuth() again and attach
 * X-RateLimit-* and Cache-Control via addPublicReadHeaders().
 */
export async function publicRateLimit(
  request: NextRequest,
  kind: PublicRateLimitKind = "read",
): Promise<PublicRateLimitResult> {
  const user = await optionalAuth(request).catch(() => null);

  const isFirehose = kind === "firehose";
  const authedConfig = isFirehose
    ? RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE_AUTHED
    : RATE_LIMIT_CONFIGS.PUBLIC_READ_AUTHED;
  const publicConfig = isFirehose
    ? RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE
    : RATE_LIMIT_CONFIGS.PUBLIC_READ;
  const anonymousConfig = isFirehose
    ? RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE_ANONYMOUS
    : RATE_LIMIT_CONFIGS.PUBLIC_READ_ANONYMOUS;

  if (isRateLimitingDisabled()) {
    return {
      error: null,
      user,
      rateLimitInfo: {
        limit: authedConfig.maxRequests,
        remaining: authedConfig.maxRequests,
        resetAt: new Date(Date.now() + authedConfig.windowMs),
      },
    };
  }

  let key: string;
  let config: (typeof RATE_LIMIT_CONFIGS)[keyof typeof RATE_LIMIT_CONFIGS];

  if (user?.userId) {
    key = user.userId;
    config = authedConfig;
  } else {
    const clientIp = getClientIp(request.headers);
    if (clientIp) {
      key = clientIp;
      config = publicConfig;
    } else {
      key = "anonymous";
      config = anonymousConfig;
    }
  }

  const result = await checkRateLimitAsync(key, config);

  if (!result.allowed) {
    logger.warn("Public rate limit exceeded", {
      key: key === "anonymous" ? "anonymous" : "[redacted]",
      actionType: config.actionType,
      retryAfter: result.retryAfter,
    });
    return {
      error: rateLimitError(result.retryAfter),
      user: null,
    };
  }

  const remaining = result.remaining ?? Math.max(0, config.maxRequests - 1);
  const resetAt = new Date(Date.now() + config.windowMs);

  return {
    error: null,
    user,
    rateLimitInfo: {
      limit: config.maxRequests,
      remaining,
      resetAt,
    },
  };
}
