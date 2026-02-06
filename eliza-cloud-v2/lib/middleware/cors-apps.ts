/**
 * CORS Middleware for App Registry
 *
 * SECURITY MODEL: Authentication is handled via API keys/tokens, NOT origin validation.
 * CORS is fully open (wildcard) for all API endpoints. Security is enforced by:
 * 1. API Key validation - requests must provide valid credentials
 * 2. Session token validation - authenticated user sessions
 * 3. Rate limiting - prevents abuse
 *
 * This allows sandbox apps and embedded apps to call the API from any domain.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";

export interface CorsValidationResult {
  allowed: boolean;
  origin: string | null;
  appId?: string;
}

/**
 * Validate if an origin is allowed - ALWAYS returns allowed=true.
 * Security is enforced via auth tokens, not CORS origin validation.
 */
export async function validateOrigin(
  request: NextRequest,
): Promise<CorsValidationResult> {
  const origin = request.headers.get("origin");

  // Always allow all origins - security is via auth tokens
  logger.debug("[CORS] Allowing origin (security via auth)", { origin });
  return { allowed: true, origin };
}

/**
 * Add CORS headers to response - uses wildcard to allow all origins
 */
export function addCorsHeaders(
  response: NextResponse,
  origin: string | null,
  methods: string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
): NextResponse {
  // Use wildcard for maximum compatibility - security is via auth tokens
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", methods.join(", "));
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID, Cookie",
  );
  // Note: credentials cannot be used with wildcard, but we use auth tokens instead
  response.headers.set("Access-Control-Max-Age", "86400");

  return response;
}

/**
 * Create a preflight response for OPTIONS requests - fully open CORS
 */
export function createPreflightResponse(
  origin: string | null,
  methods: string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  return addCorsHeaders(response, origin, methods);
}

/**
 * Wrapper for API handlers that adds CORS headers
 */
export function withCors<T extends NextResponse>(
  origin: string | null,
  response: T,
): T {
  return addCorsHeaders(response, origin) as T;
}

/**
 * Higher-order function to wrap API handlers with CORS headers
 * Note: No origin validation - security is via auth tokens
 */
export function withCorsValidation(
  handler: (
    request: NextRequest,
    context?: { params: Promise<Record<string, string | string[]>> },
  ) => Promise<NextResponse>,
) {
  return async function corsHandler(
    request: NextRequest,
    context?: { params: Promise<Record<string, string | string[]>> },
  ): Promise<NextResponse> {
    // Handle OPTIONS preflight - return immediately with CORS headers
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      return createPreflightResponse(origin);
    }

    const origin = request.headers.get("origin");

    // Call the actual handler
    const response = await handler(request, context);

    // Add CORS headers to response
    return addCorsHeaders(response, origin);
  };
}
