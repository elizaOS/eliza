/**
 * Internal Token Refresh Endpoint
 *
 * Exchanges a valid JWT for a new JWT with extended expiration.
 * Used by internal services to refresh their authentication tokens before expiry.
 *
 * POST /api/internal/auth/refresh
 * Header: Authorization: Bearer {current_jwt}
 * Returns: { access_token, token_type, expires_in }
 */

import { NextRequest, NextResponse } from "next/server";
import { isJWKSConfigured } from "@/lib/auth/jwks";
import {
  extractBearerToken,
  signInternalToken,
  verifyInternalToken,
  TOKEN_LIFETIME_SECONDS,
} from "@/lib/auth/jwt-internal";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Verify JWKS is configured
  if (!isJWKSConfigured()) {
    logger.error("[Token Refresh] JWKS not configured");
    return NextResponse.json(
      { error: "Service unavailable - JWKS not configured" },
      { status: 503 },
    );
  }

  // Extract and validate the current token
  const authHeader = request.headers.get("Authorization");
  const token = extractBearerToken(authHeader);

  if (!token) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 },
    );
  }

  // Verify the current token
  let payload;
  try {
    const result = await verifyInternalToken(token);
    payload = result.payload;
  } catch (error) {
    logger.warn("[Token Refresh] Invalid token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 },
    );
  }

  // Issue a new token with the same subject and service
  const newToken = await signInternalToken({
    subject: payload.sub,
    service: payload.service,
  });

  logger.info("[Token Refresh] Token refreshed", {
    subject: payload.sub,
    service: payload.service,
    expiresIn: TOKEN_LIFETIME_SECONDS,
  });

  return NextResponse.json(newToken);
}
