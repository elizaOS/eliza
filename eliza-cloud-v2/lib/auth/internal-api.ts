/**
 * Internal API Authentication
 *
 * Validates JWT tokens for service-to-service communication.
 * Tokens are issued by the /api/internal/auth/token endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  extractBearerToken,
  verifyInternalToken,
  type InternalJWTPayload,
} from "./jwt-internal";
import { isJWKSConfigured } from "./jwks";

// Log config issues once at startup, not on every request
if (!isJWKSConfigured() && process.env.NODE_ENV !== "test") {
  console.error(
    "[CRITICAL] JWT signing keys not configured - internal API authentication will fail",
  );
}

/**
 * Result of internal API authentication.
 * Contains the verified JWT payload with service identity.
 */
export interface InternalAuthResult {
  /** The pod name or service identifier from the JWT subject */
  podName: string;
  /** The service type (e.g., "discord-gateway") */
  service?: string;
  /** Full JWT payload for additional claims */
  payload: InternalJWTPayload;
}

/**
 * Validates and verifies the internal JWT asynchronously.
 * Returns the auth result if valid, or an error response if invalid.
 *
 * @param request - The incoming request
 * @returns Auth result with pod identity, or NextResponse error
 */
export async function validateInternalJWTAsync(
  request: NextRequest,
): Promise<InternalAuthResult | NextResponse> {
  if (!isJWKSConfigured()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = request.headers.get("Authorization");
  const token = extractBearerToken(authHeader);

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await verifyInternalToken(token);
    return {
      podName: result.payload.sub,
      service: result.payload.service,
      payload: result.payload,
    };
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Higher-order function to wrap handlers with internal JWT validation.
 * The auth result is passed to the handler for access to pod identity.
 */
export function withInternalAuth<T>(
  handler: (
    request: NextRequest,
    auth: InternalAuthResult,
    ...args: unknown[]
  ) => Promise<T>,
) {
  return async (
    request: NextRequest,
    ...args: unknown[]
  ): Promise<T | NextResponse> => {
    const authResult = await validateInternalJWTAsync(request);
    if (authResult instanceof NextResponse) {
      return authResult;
    }
    return handler(request, authResult, ...args);
  };
}
