/**
 * Rate Limiting Middleware for Next.js API Routes
 *
 * Provides helpers to apply rate limiting and duplicate detection to API routes
 */

import { logger } from "@polyagent/shared";
import { NextResponse } from "next/server";
import {
  checkDuplicate,
  type DUPLICATE_DETECTION_CONFIGS,
} from "../utils/duplicate-detector";
import { checkRateLimit, type RATE_LIMIT_CONFIGS } from "./user-rate-limiter";

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
  // SECURITY: Only skip rate limiting in test environment with EXPLICIT flag
  // Additional safeguard: also require not being in production
  const isTestEnv = process.env.NODE_ENV === "test";
  const isProduction = process.env.NODE_ENV === "production";
  const disableFlag = process.env.DISABLE_RATE_LIMITING === "true";

  if (isTestEnv && disableFlag && !isProduction) {
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
