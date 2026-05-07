/**
 * Standardized API Error Classes
 *
 * Use these error classes throughout the API to ensure consistent
 * error responses and proper HTTP status codes.
 */

import { ApiError as CanonicalApiError, type ApiErrorCode } from "@/lib/api/cloud-worker-errors";

// Avoid framework-specific response helpers in the Worker bundle; use native `Response.json`.
type JsonResponse = Response;
const JsonResponse = {
  json: (body: unknown, init?: ResponseInit): Response => Response.json(body, init),
};

export type { ApiErrorCode };

interface ApiErrorOptions {
  code: ApiErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

/**
 * Base API Error class with proper HTTP status and error code
 */
export class ApiError extends CanonicalApiError {
  constructor(options: ApiErrorOptions) {
    super(options);
    this.name = "ApiError";
  }
}

/**
 * 401 - Authentication required or invalid credentials
 */
export class AuthenticationError extends ApiError {
  constructor(message = "Authentication required") {
    super({
      code: "authentication_required",
      message,
      status: 401,
    });
    this.name = "AuthenticationError";
  }
}

/**
 * 403 - Access denied to resource
 */
export class ForbiddenError extends ApiError {
  constructor(message = "Access denied") {
    super({
      code: "access_denied",
      message,
      status: 403,
    });
    this.name = "ForbiddenError";
  }
}

/**
 * 404 - Resource not found
 */
export class NotFoundError extends ApiError {
  constructor(message = "Resource not found") {
    super({
      code: "resource_not_found",
      message,
      status: 404,
    });
    this.name = "NotFoundError";
  }
}

/**
 * 429 - Rate limit exceeded
 */
export class RateLimitError extends ApiError {
  public readonly retryAfter?: number;

  constructor(message = "Rate limit exceeded", retryAfter?: number) {
    super({
      code: "rate_limit_exceeded",
      message,
      status: 429,
      details: retryAfter ? { retryAfter } : undefined,
    });
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

/**
 * 400 - Validation error
 */
export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "validation_error",
      message,
      status: 400,
      details,
    });
    this.name = "ValidationError";
  }
}

/**
 * 402 - Insufficient credits
 */
export class InsufficientCreditsError extends ApiError {
  constructor(message = "Insufficient credits") {
    super({
      code: "insufficient_credits",
      message,
      status: 402,
    });
    this.name = "InsufficientCreditsError";
  }
}

/**
 * 409 - Session not in expected state
 */
export class SessionNotReadyError extends ApiError {
  constructor(message = "Session is not ready") {
    super({
      code: "session_not_ready",
      message,
      status: 409,
    });
    this.name = "SessionNotReadyError";
  }
}

/**
 * Map an unknown error to appropriate HTTP status code
 * Uses error type checking instead of fragile string matching
 */
export function getErrorStatusCode(error: unknown): number {
  if (error instanceof CanonicalApiError) {
    return error.status;
  }
  if (error instanceof ApiError) {
    return error.status;
  }

  // For backwards compatibility with existing error messages
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Check error name first (more reliable than message)
    if (error.name === "InsufficientCreditsError") {
      return 402;
    }
    if (error.name === "AuthenticationError" || error.name === "UnauthorizedError") {
      return 401;
    }
    if (error.name === "ForbiddenError" || error.name === "AccessDeniedError") {
      return 403;
    }
    if (error.name === "NotFoundError") {
      return 404;
    }
    if (error.name === "RateLimitError") {
      return 429;
    }

    // DB / internal failures that mention "authentication" must stay 500 (compat routes)
    if (
      message.includes("password authentication failed") ||
      message.includes("authentication failed for user")
    ) {
      return 500;
    }

    // Compat: only these "Invalid …" phrases are auth failures (not blanket "invalid")
    if (
      message.includes("invalid api key") ||
      message.includes("invalid token") ||
      message.includes("invalid credentials") ||
      message.includes("invalid service key")
    ) {
      return 401;
    }

    // Compat: narrowed "requires …" for access control (not "table requires migration")
    if (
      message.includes("requires authentication") ||
      message.includes("requires authorization") ||
      message.includes("requires admin") ||
      message.includes("requires owner") ||
      message.includes("requires org membership")
    ) {
      return 403;
    }

    // Fallback to message matching for legacy errors
    if (
      message.includes("authentication") ||
      message.includes("unauthorized") ||
      message.includes("not authenticated")
    ) {
      return 401;
    }
    if (
      message.includes("access denied") ||
      message.includes("forbidden") ||
      message.includes("permission")
    ) {
      return 403;
    }
    if (message.includes("organization") && message.includes("inactive")) {
      return 403;
    }
    if (message.includes("not found")) {
      return 404;
    }
    if (message.includes("rate limit")) {
      return 429;
    }
    if (message.includes("not ready")) {
      return 409;
    }
  }

  return 500;
}

function inferApiErrorCodeFromHttpStatus(status: number): ApiErrorCode {
  if (status === 401) return "authentication_required";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "access_denied";
  if (status === 404) return "resource_not_found";
  if (status === 409) return "session_not_ready";
  if (status === 429) return "rate_limit_exceeded";
  return "internal_error";
}

/**
 * Get a safe error message for client response
 * Avoids leaking internal details
 */
export function getSafeErrorMessage(error: unknown): string {
  if (error instanceof CanonicalApiError) {
    return error.message;
  }
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Never leak DB/auth backend details even if they contain "safe" keywords
    const denyPatterns = [
      "password authentication failed",
      "authentication failed for user",
      "connection refused",
      "ECONNREFUSED",
      "database",
      "postgres",
      "redis",
      "SASL",
      "socket",
      "timeout expired",
      "connect ETIMEDOUT",
      "getaddrinfo",
      "ENOTFOUND",
    ];
    if (denyPatterns.some((pattern) => message.includes(pattern.toLowerCase()))) {
      return "An unexpected error occurred";
    }

    // Allow certain error messages through for non-500 errors
    const safePatterns = [
      "not found",
      "access denied",
      "authentication",
      "unauthorized",
      "rate limit",
      "not ready",
      "insufficient",
    ];

    if (message.includes("organization") && message.includes("inactive")) {
      return error.message;
    }
    // Only apply safePatterns for client errors (< 500), not internal failures
    const status = getErrorStatusCode(error);
    if (status < 500 && safePatterns.some((pattern) => message.includes(pattern))) {
      return error.message;
    }
  }

  // Default generic message for unexpected errors
  return "An unexpected error occurred";
}

/** Shared JSON body + status for caught errors. */
export function caughtErrorJson(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  const status = getErrorStatusCode(error);
  if (error instanceof CanonicalApiError) {
    return { status, body: error.toJSON() };
  }
  if (error instanceof ApiError) {
    return { status, body: error.toJSON() };
  }
  return {
    status,
    body: {
      success: false,
      error: getSafeErrorMessage(error),
      code: inferApiErrorCodeFromHttpStatus(status),
    },
  };
}

/**
 * Native `Response` for route catches (e.g. MCP / undici polyfill pitfalls).
 */
export function apiFailureResponse(error: unknown): Response {
  const { status, body } = caughtErrorJson(error);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** JSON error response for route handlers — same shape as `apiFailureResponse`. */
export function nextJsonFromCaughtError(error: unknown): JsonResponse {
  const { status, body } = caughtErrorJson(error);
  return JsonResponse.json(body, { status });
}

/** Same as `nextJsonFromCaughtError` but merges CORS or cache headers onto the error response. */
export function nextJsonFromCaughtErrorWithHeaders(
  error: unknown,
  headers?: Record<string, string>,
): JsonResponse {
  const { status, body } = caughtErrorJson(error);
  return JsonResponse.json(body, { status, headers });
}

/**
 * Create a JSON response from an error
 */
export function errorToResponse(error: unknown): Response {
  const status = getErrorStatusCode(error);
  const message = getSafeErrorMessage(error);

  const body =
    error instanceof CanonicalApiError || error instanceof ApiError
      ? error.toJSON()
      : { success: false, error: message };

  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Minimal JSON error body for edge middleware and native `Response` paths.
 * Shape matches `ApiError.toJSON()` (`success`, `error`, `code`).
 */
export function jsonError(
  message: string,
  status: number,
  code: ApiErrorCode,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }
  return new Response(JSON.stringify({ success: false, error: message, code }), {
    status,
    headers,
  });
}
