/**
 * Base error classes for the Polyagent application
 *
 * @description Provides structured error handling with proper context and metadata.
 * All application errors extend PolyagentError, which includes timestamp, context,
 * error codes, and operational flags for consistent error handling.
 */

/**
 * Base error class for all Polyagent errors
 *
 * @description Extends the native Error class with additional context and metadata.
 * All application errors should extend this class for consistent error handling,
 * logging, and API responses.
 */
export abstract class PolyagentError extends Error {
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date();
    this.context = context;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON for logging and API responses
   *
   * @description Serializes the error to a JSON object suitable for logging
   * and API responses. Includes stack trace in development mode.
   *
   * @returns {object} JSON representation of the error
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      timestamp: this.timestamp,
      context: this.context,
      ...(process.env.NODE_ENV === "development" && { stack: this.stack }),
    };
  }
}

/**
 * Validation error for input validation failures
 *
 * @description Error thrown when input validation fails. Includes field-level
 * violations for detailed error reporting.
 */
export class ValidationError extends PolyagentError {
  constructor(
    message: string,
    public readonly fields?: string[],
    public readonly violations?: Array<{ field: string; message: string }>,
  ) {
    super(message, "VALIDATION_ERROR", 400, true, { fields, violations });
  }
}

/**
 * Authentication error for auth failures
 *
 * @description Error thrown when authentication fails. Includes reason code
 * for different failure types (NO_TOKEN, INVALID_TOKEN, etc.).
 */
export class AuthenticationError extends PolyagentError {
  constructor(
    message: string,
    public readonly reason:
      | "NO_TOKEN"
      | "INVALID_TOKEN"
      | "EXPIRED_TOKEN"
      | "INVALID_CREDENTIALS",
  ) {
    super(message, `AUTH_${reason}`, 401, true, { reason });
  }
}

/**
 * Authorization error for permission failures
 *
 * @description Error thrown when authorization/permission checks fail.
 * Includes resource and action context for detailed error messages.
 */
export class AuthorizationError extends PolyagentError {
  constructor(
    message: string,
    public readonly resource: string,
    public readonly action: string,
  ) {
    super(message, "FORBIDDEN", 403, true, { resource, action });
  }
}

/**
 * Not found error for missing resources
 *
 * @description Error thrown when a requested resource is not found.
 * Supports custom messages and resource identifiers.
 */
export class NotFoundError extends PolyagentError {
  constructor(
    resource: string,
    identifier?: string | number,
    customMessage?: string,
  ) {
    const message =
      customMessage ||
      (identifier !== undefined
        ? `${resource} not found: ${identifier}`
        : `${resource} not found`);

    super(message, "NOT_FOUND", 404, true, { resource, identifier });
  }
}

/**
 * Conflict error for duplicate resources or conflicting operations
 *
 * @description Error thrown when an operation conflicts with existing state,
 * such as duplicate resources or concurrent modifications.
 */
export class ConflictError extends PolyagentError {
  constructor(
    message: string,
    public readonly conflictingResource?: string,
  ) {
    super(message, "CONFLICT", 409, true, { conflictingResource });
  }
}

/**
 * Database error for database issues
 *
 * @description Error thrown when database operations fail. Includes operation
 * context and original error information for debugging.
 */
export class DatabaseError extends PolyagentError {
  constructor(
    message: string,
    public readonly operation: string,
    originalError?: Error,
  ) {
    super(message, "DATABASE_ERROR", 500, true, {
      operation,
      originalError: originalError?.message,
      originalStack:
        process.env.NODE_ENV === "development"
          ? originalError?.stack
          : undefined,
    });
  }
}

/**
 * External service error for third-party service failures
 *
 * @description Error thrown when external service calls fail. Includes service
 * name and original status code for debugging.
 */
export class ExternalServiceError extends PolyagentError {
  constructor(
    service: string,
    message: string,
    public readonly originalStatusCode?: number,
  ) {
    super(`${service}: ${message}`, "EXTERNAL_SERVICE_ERROR", 502, true, {
      service,
      originalStatusCode,
    });
  }
}

/**
 * Rate limit error for rate limiting
 *
 * @description Error thrown when rate limits are exceeded. Includes limit,
 * window duration, and optional retry-after information.
 */
export class RateLimitError extends PolyagentError {
  constructor(
    public readonly limit: number,
    public readonly windowMs: number,
    public readonly retryAfter?: number,
  ) {
    super(
      `Rate limit exceeded: ${limit} requests per ${windowMs}ms`,
      "RATE_LIMIT",
      429,
      true,
      { limit, windowMs, retryAfter },
    );
  }
}

/**
 * Business logic error for domain-specific errors
 *
 * @description Error thrown for domain-specific business logic violations.
 * Allows custom error codes and context for specific business rules.
 */
export class BusinessLogicError extends PolyagentError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message, code, 400, true, context);
  }
}

/**
 * Bad request error for malformed requests
 *
 * @description Error thrown for malformed or invalid requests. Includes
 * optional details for debugging.
 */
export class BadRequestError extends PolyagentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "BAD_REQUEST", 400, true, details);
  }
}

/**
 * Internal server error for unexpected failures
 *
 * @description Error thrown for unexpected server failures. Marked as
 * non-operational (programming errors) rather than expected errors.
 */
export class InternalServerError extends PolyagentError {
  constructor(
    message = "An unexpected error occurred",
    details?: Record<string, unknown>,
  ) {
    super(message, "INTERNAL_ERROR", 500, false, details);
  }
}

/**
 * Service unavailable error for temporary outages
 *
 * @description Error thrown when a service is temporarily unavailable.
 * Includes optional retry-after information for clients.
 */
export class ServiceUnavailableError extends PolyagentError {
  constructor(
    message = "Service temporarily unavailable",
    public readonly retryAfter?: number,
  ) {
    super(message, "SERVICE_UNAVAILABLE", 503, true, { retryAfter });
  }
}
