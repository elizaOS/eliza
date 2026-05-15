/**
 * Internal API Authentication
 *
 * Validates JWT tokens for service-to-service communication.
 * Tokens are issued by the /api/internal/auth/token endpoint.
 */

import { isJWKSConfigured } from "./jwks";
import { extractBearerToken, type InternalJWTPayload, verifyInternalToken } from "./jwt-internal";

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
 * @returns Auth result with pod identity, or Response error
 */
export async function validateInternalJWTAsync(
  request: Request,
): Promise<InternalAuthResult | Response> {
  if (!isJWKSConfigured()) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = request.headers.get("Authorization");
  const token = extractBearerToken(authHeader);

  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await verifyInternalToken(token);
    return {
      podName: result.payload.sub,
      service: result.payload.service,
      payload: result.payload,
    };
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Higher-order function to wrap handlers with internal JWT validation.
 * The auth result is passed to the handler for access to pod identity.
 */
export function withInternalAuth<T>(
  handler: (request: Request, auth: InternalAuthResult, ...args: unknown[]) => Promise<T>,
) {
  return async (request: Request, ...args: unknown[]): Promise<T | Response> => {
    const authResult = await validateInternalJWTAsync(request);
    if (authResult instanceof Response) {
      return authResult;
    }
    return handler(request, authResult, ...args);
  };
}
