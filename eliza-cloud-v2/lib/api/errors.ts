/**
 * Standardized API Error Classes
 *
 * Use these error classes throughout the API to ensure consistent
 * error responses and proper HTTP status codes.
 */

export type ApiErrorCode =
  | "authentication_required"
  | "invalid_credentials"
  | "access_denied"
  | "forbidden"
  | "resource_not_found"
  | "rate_limit_exceeded"
  | "validation_error"
  | "insufficient_credits"
  | "session_not_ready"
  | "internal_error";

interface ApiErrorOptions {
  code: ApiErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

/**
 * Base API Error class with proper HTTP status and error code
 */
export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }

  toJSON() {
    return {
      success: false,
      error: this.message,
      code: this.code,
      ...(this.details && { details: this.details }),
    };
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
  if (error instanceof ApiError) {
    return error.status;
  }

  // For backwards compatibility with existing error messages
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Check error name first (more reliable than message)
    if (
      error.name === "AuthenticationError" ||
      error.name === "UnauthorizedError"
    ) {
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

/**
 * Get a safe error message for client response
 * Avoids leaking internal details
 */
export function getSafeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    // Allow certain error messages through
    const safePatterns = [
      "not found",
      "access denied",
      "authentication",
      "unauthorized",
      "rate limit",
      "not ready",
      "insufficient",
    ];

    const message = error.message.toLowerCase();
    if (safePatterns.some((pattern) => message.includes(pattern))) {
      return error.message;
    }
  }

  // Default generic message for unexpected errors
  return "An unexpected error occurred";
}

/**
 * Create a JSON response from an error
 */
export function errorToResponse(error: unknown): Response {
  const status = getErrorStatusCode(error);
  const message = getSafeErrorMessage(error);

  const body =
    error instanceof ApiError
      ? error.toJSON()
      : { success: false, error: message };

  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
