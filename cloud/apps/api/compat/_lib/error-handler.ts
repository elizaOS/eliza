/**
 * Shared error handler for compat routes.
 *
 * Maps errors to HTTP status codes via `ApiError` subclasses, then
 * `getErrorStatusCode` (typed names + conservative message heuristics)
 * for legacy `Error` throws from dependencies.
 *
 * 500-level responses intentionally return a generic message to
 * avoid leaking internal details (e.g. missing env vars, DB
 * connection strings). The original error is logged server-side.
 */

import { errorEnvelope } from "@/lib/api/compat-envelope";
import { ApiError, getErrorStatusCode } from "@/lib/api/errors";
import { ServiceKeyAuthError } from "@/lib/auth/service-key";
import { applyCorsHeaders } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";

function compatErrorResponse(message: string, status: number, methods: string): Response {
  return applyCorsHeaders(Response.json(errorEnvelope(message), { status }), methods);
}

export function handleCompatError(err: unknown, methods = "GET, POST, DELETE, OPTIONS"): Response {
  // 1. Typed API errors — use their built-in status / message.
  if (err instanceof ApiError) {
    return compatErrorResponse(err.message, err.status, methods);
  }

  // 2. Service-key auth failures → 401.
  if (err instanceof ServiceKeyAuthError) {
    return compatErrorResponse(err.message, 401, methods);
  }

  // 3. Generic Error — map status via `getErrorStatusCode` (typed + message heuristics).
  if (err instanceof Error) {
    const status = getErrorStatusCode(err);
    if (status < 500) {
      return compatErrorResponse(err.message, status, methods);
    }

    logger.error("[compat] Unhandled error", {
      error: err.message,
      stack: err.stack,
    });
    return compatErrorResponse("Internal server error", 500, methods);
  }

  // 4. Non-Error throw — always generic.
  logger.error("[compat] Unhandled non-Error throw", { value: String(err) });
  return compatErrorResponse("Internal server error", 500, methods);
}
