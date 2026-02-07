import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { logger } from "@/lib/utils/logger";
import { createHash } from "node:crypto";

/**
 * Simple in-memory rate limiter for polling endpoint.
 * Limits requests per token to prevent abuse.
 *
 * Note: This is per-instance in serverless, which is acceptable
 * for a polling endpoint - stricter limits use Redis.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per token

function checkRateLimit(token: string): {
  allowed: boolean;
  remaining: number;
} {
  const now = Date.now();
  const entry = rateLimitMap.get(token);

  // Periodic cleanup - remove entries older than 5 minutes
  if (rateLimitMap.size > 1000) {
    const cutoff = now - 5 * RATE_LIMIT_WINDOW_MS;
    for (const [key, value] of rateLimitMap.entries()) {
      if (value.resetAt < cutoff) {
        rateLimitMap.delete(key);
      }
    }
  }

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(token, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - entry.count };
}

/**
 * Hash a token for safe logging (prevents partial token exposure)
 */
function hashTokenForLogging(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Validate session token format
 * Session tokens should be at least 16 characters (nanoid or UUID format)
 */
function isValidTokenFormat(token: string): boolean {
  return typeof token === "string" && token.length >= 16 && token.length <= 64;
}

/**
 * GET /api/anonymous-session - Get anonymous session data by token
 *
 * This endpoint allows the frontend to poll for updated session info,
 * particularly the message_count which is incremented on the backend.
 *
 * Security:
 * - Validates token format before database query
 * - Hashes tokens for logging (prevents exposure)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    // Input validation
    if (!token) {
      return NextResponse.json(
        { error: "Session token is required" },
        { status: 400 },
      );
    }

    if (!isValidTokenFormat(token)) {
      logger.warn("[Anonymous Session API] Invalid token format");
      return NextResponse.json(
        { error: "Invalid session token format" },
        { status: 400 },
      );
    }

    // Rate limiting per token
    const rateLimit = checkRateLimit(token);
    if (!rateLimit.allowed) {
      logger.warn("[Anonymous Session API] Rate limit exceeded for token");
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": "60",
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }

    const tokenHash = hashTokenForLogging(token);
    logger.debug("[Anonymous Session API] GET request received:", {
      tokenHash,
      remaining: rateLimit.remaining,
    });

    const session = await anonymousSessionsService.getByToken(token);

    if (!session) {
      logger.warn(
        `[Anonymous Session API] Session not found for token hash: ${tokenHash}`,
      );
      return NextResponse.json(
        { error: "Session not found or expired" },
        { status: 404 },
      );
    }

    logger.debug("[Anonymous Session API] Returning session data:", {
      sessionId: session.id,
      messageCount: session.message_count,
      messagesLimit: session.messages_limit,
    });

    return NextResponse.json(
      {
        success: true,
        session: {
          id: session.id,
          message_count: session.message_count,
          messages_limit: session.messages_limit,
          messages_remaining: session.messages_limit - session.message_count,
          is_active: session.is_active,
          expires_at: session.expires_at,
        },
      },
      {
        headers: {
          "X-RateLimit-Remaining": String(rateLimit.remaining),
        },
      },
    );
  } catch (error) {
    logger.error("[Anonymous Session API] Error:", error);
    return NextResponse.json(
      { error: "Failed to get session data" },
      { status: 500 },
    );
  }
}
