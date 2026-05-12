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

import { CORS_ALLOW_HEADERS, CORS_MAX_AGE } from "@/lib/cors-constants";
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
export async function validateOrigin(request: Request): Promise<CorsValidationResult> {
  const origin = request.headers.get("origin");

  // Always allow all origins - security is via auth tokens
  logger.debug("[CORS] Allowing origin (security via auth)", { origin });
  return { allowed: true, origin };
}

/**
 * Add CORS headers to response - uses wildcard to allow all origins
 */
export function addCorsHeaders(
  response: Response,
  origin: string | null,
  methods: string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
): Response {
  // Use wildcard for maximum compatibility - security is via auth tokens
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", methods.join(", "));
  response.headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  // Note: credentials cannot be used with wildcard, but we use auth tokens instead
  response.headers.set("Access-Control-Max-Age", CORS_MAX_AGE);

  return response;
}

/**
 * Create a preflight response for OPTIONS requests - fully open CORS
 */
export function createPreflightResponse(
  origin: string | null,
  methods: string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
): Response {
  const response = new Response(null, { status: 204 });
  return addCorsHeaders(response, origin, methods);
}

/**
 * Wrapper for API handlers that adds CORS headers
 */
export function withCors<T extends Response>(origin: string | null, response: T): T {
  return addCorsHeaders(response, origin) as T;
}

/**
 * Higher-order function to wrap API handlers with CORS headers
 * Note: No origin validation - security is via auth tokens
 */
export function withCorsValidation(
  handler: (
    request: Request,
    context?: { params: Promise<Record<string, string | string[]>> },
  ) => Promise<Response>,
) {
  return async function corsHandler(
    request: Request,
    context?: { params: Promise<Record<string, string | string[]>> },
  ): Promise<Response> {
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
