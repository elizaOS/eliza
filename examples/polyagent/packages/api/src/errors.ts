/**
 * API Error Classes
 *
 * Error classes for API authentication and authorization
 */

import type { JsonValue } from "./types";

/**
 * Base API Error class (simple version for compatibility)
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Base error class for Polyagent API errors
 */
export abstract class PolyagentError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, JsonValue>;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    isOperational = true,
    context?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.context = context;

    // Maintain proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends PolyagentError {
  constructor(
    message = "Authentication required",
    context?: Record<string, JsonValue>,
  ) {
    super(message, "AUTH_FAILED", 401, true, context);
  }
}

/**
 * Authorization error
 */
export class AuthorizationError extends PolyagentError {
  public readonly resource?: string;
  public readonly action?: string;

  constructor(
    message = "Access denied",
    resource?: string,
    action?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, "FORBIDDEN", 403, true, context);
    this.resource = resource;
    this.action = action;
  }
}

/**
 * Type guard to check if an error is an authentication error
 */
export function isAuthenticationError(
  error: unknown,
): error is AuthenticationError {
  return error instanceof AuthenticationError;
}

/**
 * Type guard to check if an error is an authorization error
 */
export function isAuthorizationError(
  error: unknown,
): error is AuthorizationError {
  return error instanceof AuthorizationError;
}

/**
 * Bad Request Error (400)
 */
export class BadRequestError extends PolyagentError {
  constructor(
    message: string,
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "BAD_REQUEST", 400, true, context);
  }
}

/**
 * Unauthorized Error (401)
 */
export class UnauthorizedError extends PolyagentError {
  constructor(
    message = "Unauthorized",
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "UNAUTHORIZED", 401, true, context);
  }
}

/**
 * Forbidden Error (403)
 */
export class ForbiddenError extends PolyagentError {
  constructor(
    message = "Forbidden",
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "FORBIDDEN", 403, true, context);
  }
}

/**
 * Not Found Error (404)
 */
export class NotFoundError extends PolyagentError {
  constructor(
    resource = "Resource",
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(`${resource} not found`, code || "NOT_FOUND", 404, true, context);
  }
}

/**
 * Conflict Error (409)
 */
export class ConflictError extends PolyagentError {
  constructor(
    message: string,
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "CONFLICT", 409, true, context);
  }
}

/**
 * Validation Error (422)
 */
export class ValidationError extends PolyagentError {
  public readonly errors?: Record<string, string[]>;

  constructor(
    message: string,
    errors?: Record<string, string[]>,
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "VALIDATION_ERROR", 422, true, context);
    this.errors = errors;
  }
}

/**
 * Rate Limit Error (429)
 */
export class RateLimitError extends PolyagentError {
  public readonly reset?: number;

  constructor(
    message = "Too many requests",
    reset?: number,
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "RATE_LIMIT", 429, true, context);
    this.reset = reset;
  }
}

/**
 * Internal Server Error (500)
 */
export class InternalServerError extends PolyagentError {
  constructor(
    message = "Internal server error",
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "INTERNAL_ERROR", 500, false, context);
  }
}

/**
 * Service Unavailable Error (503)
 */
export class ServiceUnavailableError extends PolyagentError {
  constructor(
    message = "Service temporarily unavailable",
    code?: string,
    context?: Record<string, JsonValue>,
  ) {
    super(message, code || "SERVICE_UNAVAILABLE", 503, true, context);
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
    context?: Record<string, JsonValue>,
  ) {
    super(message, code, 400, true, context);
  }
}

/**
 * Error code constants for consistency across the application
 *
 * @description Standardized error codes used throughout the application
 * for consistent error identification and handling.
 */
export const ErrorCodes = {
  // General errors
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",

  // Auth errors
  AUTH_NO_TOKEN: "AUTH_NO_TOKEN",
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  AUTH_EXPIRED_TOKEN: "AUTH_EXPIRED_TOKEN",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  FORBIDDEN: "FORBIDDEN",

  // Database errors
  DATABASE_ERROR: "DATABASE_ERROR",
  DUPLICATE_ENTRY: "DUPLICATE_ENTRY",
  FOREIGN_KEY_CONSTRAINT: "FOREIGN_KEY_CONSTRAINT",

  // Business logic errors
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  RATE_LIMIT: "RATE_LIMIT",

  // Trading errors
  TRADING_MARKET_CLOSED: "TRADING_MARKET_CLOSED",
  TRADING_INVALID_PRICE: "TRADING_INVALID_PRICE",
  TRADING_POSITION_LIMIT: "TRADING_POSITION_LIMIT",
  TRADING_RISK_LIMIT: "TRADING_RISK_LIMIT",

  // Agent errors
  AGENT_ERROR: "AGENT_ERROR",
  AGENT_AUTH_NOT_REGISTERED: "AGENT_AUTH_NOT_REGISTERED",
  AGENT_AUTH_INVALID_SIGNATURE: "AGENT_AUTH_INVALID_SIGNATURE",

  // External service errors
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  BLOCKCHAIN_ERROR: "BLOCKCHAIN_ERROR",
  SMART_CONTRACT_ERROR: "SMART_CONTRACT_ERROR",
  LLM_ERROR: "LLM_ERROR",
} as const;

/**
 * Type guard to check if an error is a Polyagent error
 *
 * @description Determines if an error is an instance of PolyagentError,
 * allowing type-safe error handling.
 *
 * @param {unknown} error - Error to check
 * @returns {boolean} True if error is a PolyagentError
 */
export function isPolyagentError(error: unknown): error is PolyagentError {
  return error instanceof PolyagentError;
}

/**
 * Type guard to check if an error is operational (expected)
 *
 * @description Determines if an error is operational (expected and handled)
 * vs programming errors (unexpected bugs).
 *
 * @param {unknown} error - Error to check
 * @returns {boolean} True if error is operational
 */
export function isOperationalError(error: unknown): boolean {
  if (isPolyagentError(error)) {
    return error.isOperational;
  }
  return false;
}

/**
 * Standard error response object
 *
 * @description Structure for API error responses, including error message,
 * code, validation violations, and optional context.
 */
export interface ErrorResponse {
  error: {
    message: string;
    code: string;
    violations?: Array<{ field: string; message: string }>;
    context?: Record<string, JsonValue>;
  };
}

/**
 * Create a standardized error response object
 *
 * @description Converts a PolyagentError to a standardized ErrorResponse
 * format suitable for API responses. Includes validation violations if present
 * and context in development mode.
 *
 * @param {PolyagentError} error - Polyagent error to convert
 * @returns {ErrorResponse} Standardized error response
 */
export function createErrorResponse(error: PolyagentError): ErrorResponse {
  return {
    error: {
      message: error.message,
      code: error.code,
      ...(error instanceof ValidationError &&
        error.errors && {
          violations: Object.entries(error.errors).flatMap(
            ([field, messages]) =>
              messages.map((message) => ({ field, message })),
          ),
        }),
      ...(process.env.NODE_ENV === "development" &&
        error.context && {
          context: error.context as Record<string, JsonValue>,
        }),
    },
  };
}
