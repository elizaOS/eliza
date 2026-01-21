/**
 * Error Classes for @polyagent/agents
 *
 * Provides structured error handling with proper context and metadata for
 * all error scenarios including validation, authentication, authorization,
 * and external service failures.
 *
 * @packageDocumentation
 */

/**
 * Base error class for all Polyagent errors
 *
 * Provides structured error handling with timestamps, context, and proper
 * error codes for API responses.
 */
import type { JsonValue } from "../types/common";

export abstract class PolyagentError extends Error {
  public readonly timestamp: Date;
  public readonly context?: Record<string, JsonValue>;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true,
    context?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date();
    this.context = context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

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
 * Thrown when input parameters fail validation checks.
 */
export class ValidationError extends PolyagentError {
  constructor(
    message: string,
    public readonly fields?: string[],
    public readonly violations?: Array<{ field: string; message: string }>,
  ) {
    const context: Record<string, JsonValue> = {};
    if (fields !== undefined) context.fields = fields as JsonValue;
    if (violations !== undefined)
      context.violations = violations as unknown as JsonValue;
    super(message, "VALIDATION_ERROR", 400, true, context);
  }
}

/**
 * Authentication error for authentication failures
 *
 * Thrown when authentication fails due to missing, invalid, or expired tokens.
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
 * Thrown when a user lacks permission to perform a requested action.
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
 * Thrown when a requested resource does not exist.
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

    const context: Record<string, JsonValue> = { resource };
    if (identifier !== undefined) context.identifier = identifier as JsonValue;
    super(message, "NOT_FOUND", 404, true, context);
  }
}

/**
 * Conflict error for duplicate resources or conflicting operations
 *
 * Thrown when an operation conflicts with existing state.
 */
export class ConflictError extends PolyagentError {
  constructor(
    message: string,
    public readonly conflictingResource?: string,
  ) {
    const context: Record<string, JsonValue> = {};
    if (conflictingResource !== undefined)
      context.conflictingResource = conflictingResource as JsonValue;
    super(message, "CONFLICT", 409, true, context);
  }
}

/**
 * Database error for database operation failures
 *
 * Thrown when database operations fail.
 */
export class DatabaseError extends PolyagentError {
  constructor(
    message: string,
    public readonly operation: string,
    originalError?: Error,
  ) {
    const context: Record<string, JsonValue> = { operation };
    if (originalError?.message)
      context.originalError = originalError.message as JsonValue;
    if (process.env.NODE_ENV === "development" && originalError?.stack) {
      context.originalStack = originalError.stack as JsonValue;
    }
    super(message, "DATABASE_ERROR", 500, true, context);
  }
}

/**
 * External service error for third-party service failures
 *
 * Thrown when external service calls fail.
 */
export class ExternalServiceError extends PolyagentError {
  constructor(
    service: string,
    message: string,
    public readonly originalStatusCode?: number,
  ) {
    const context: Record<string, JsonValue> = { service };
    if (originalStatusCode !== undefined)
      context.originalStatusCode = originalStatusCode as JsonValue;
    super(
      `${service}: ${message}`,
      "EXTERNAL_SERVICE_ERROR",
      502,
      true,
      context,
    );
  }
}

/**
 * Rate limit error for rate limiting
 */
export class RateLimitError extends PolyagentError {
  constructor(
    public readonly limit: number,
    public readonly windowMs: number,
    public readonly retryAfter?: number,
  ) {
    const context: Record<string, JsonValue> = { limit, windowMs };
    if (retryAfter !== undefined) context.retryAfter = retryAfter as JsonValue;
    super(
      `Rate limit exceeded: ${limit} requests per ${windowMs}ms`,
      "RATE_LIMIT",
      429,
      true,
      context,
    );
  }
}

/**
 * Business logic error for domain-specific errors
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
 * Bad request error for malformed requests
 */
export class BadRequestError extends PolyagentError {
  constructor(message: string, details?: Record<string, JsonValue>) {
    super(message, "BAD_REQUEST", 400, true, details);
  }
}

/**
 * Internal server error for unexpected failures
 */
export class InternalServerError extends PolyagentError {
  constructor(
    message = "An unexpected error occurred",
    details?: Record<string, JsonValue>,
  ) {
    super(message, "INTERNAL_ERROR", 500, false, details);
  }
}

/**
 * Service unavailable error for temporary outages
 */
export class ServiceUnavailableError extends PolyagentError {
  constructor(
    message = "Service temporarily unavailable",
    public readonly retryAfter?: number,
  ) {
    const context: Record<string, JsonValue> = {};
    if (retryAfter !== undefined) context.retryAfter = retryAfter;
    super(message, "SERVICE_UNAVAILABLE", 503, true, context);
  }
}

// Agent0 errors - defined inline to avoid circular dependency
// These classes extend ExternalServiceError and RateLimitError defined above

/**
 * Base error class for all Agent0 operations
 */
export class Agent0Error extends ExternalServiceError {
  public readonly operation:
    | "register"
    | "feedback"
    | "reputation"
    | "search"
    | "discovery";
  public readonly agent0Code?: string;

  constructor(
    message: string,
    operation: "register" | "feedback" | "reputation" | "search" | "discovery",
    agent0Code?: string,
    originalError?: Error,
    originalStatusCode?: number,
  ) {
    // Pass enhanced context to parent
    super("Agent0", message, originalStatusCode);
    this.operation = operation;
    this.agent0Code = agent0Code;

    // Context is set in parent, but we can access it via toJSON()
    Object.assign(this, {
      context: {
        ...this.context,
        operation,
        agent0Code,
        originalError: originalError?.message,
        originalStack:
          process.env.NODE_ENV === "development"
            ? originalError?.stack
            : undefined,
      },
    });
  }

  /**
   * Type guard for Agent0Error
   */
  static isInstance(error: unknown): error is Agent0Error {
    return error instanceof Agent0Error;
  }

  /**
   * Check if error is retryable
   */
  isRetryable(): boolean {
    // Network errors and 5xx errors are retryable
    if (this.originalStatusCode && this.originalStatusCode >= 500) {
      return true;
    }

    // Specific retryable error codes
    const retryableMessages = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "NetworkError",
      "timeout",
      "network",
    ];

    return retryableMessages.some((msg) =>
      this.message.toLowerCase().includes(msg.toLowerCase()),
    );
  }
}

/**
 * Error for Agent0 registration failures
 */
export class Agent0RegistrationError extends Agent0Error {
  public readonly agentName?: string;

  constructor(
    message: string,
    agentName?: string,
    agent0Code?: string,
    originalError?: Error,
    originalStatusCode?: number,
  ) {
    super(message, "register", agent0Code, originalError, originalStatusCode);
    this.agentName = agentName;

    Object.assign(this, {
      context: {
        ...this.context,
        agentName,
      },
    });
  }

  static isInstance(error: unknown): error is Agent0RegistrationError {
    return error instanceof Agent0RegistrationError;
  }
}

/**
 * Error for Agent0 feedback submission failures
 */
export class Agent0FeedbackError extends Agent0Error {
  public readonly feedbackId?: string;

  constructor(
    message: string,
    feedbackId?: string,
    agent0Code?: string,
    originalError?: Error,
    originalStatusCode?: number,
  ) {
    super(message, "feedback", agent0Code, originalError, originalStatusCode);
    this.feedbackId = feedbackId;

    Object.assign(this, {
      context: {
        ...this.context,
        feedbackId,
      },
    });
  }

  static isInstance(error: unknown): error is Agent0FeedbackError {
    return error instanceof Agent0FeedbackError;
  }
}

/**
 * Error for Agent0 reputation query failures
 */
export class Agent0ReputationError extends Agent0Error {
  public readonly tokenId?: number;

  constructor(
    message: string,
    tokenId?: number,
    agent0Code?: string,
    originalError?: Error,
    originalStatusCode?: number,
  ) {
    super(message, "reputation", agent0Code, originalError, originalStatusCode);
    this.tokenId = tokenId;

    Object.assign(this, {
      context: {
        ...this.context,
        tokenId,
      },
    });
  }

  static isInstance(error: unknown): error is Agent0ReputationError {
    return error instanceof Agent0ReputationError;
  }
}

/**
 * Error for Agent0 search/discovery failures
 */
export class Agent0SearchError extends Agent0Error {
  public readonly filters?: Record<string, JsonValue>;

  constructor(
    message: string,
    filters?: Record<string, JsonValue>,
    agent0Code?: string,
    originalError?: Error,
    originalStatusCode?: number,
  ) {
    super(message, "search", agent0Code, originalError, originalStatusCode);
    this.filters = filters;

    Object.assign(this, {
      context: {
        ...this.context,
        filters,
      },
    });
  }

  static isInstance(error: unknown): error is Agent0SearchError {
    return error instanceof Agent0SearchError;
  }
}

/**
 * Error for duplicate feedback submission attempts
 */
export class Agent0DuplicateFeedbackError extends Agent0FeedbackError {
  constructor(feedbackId: string, targetAgentId: number) {
    super(
      `Duplicate feedback submission for feedback ${feedbackId} targeting agent ${targetAgentId}`,
      feedbackId,
      "DUPLICATE_FEEDBACK",
    );

    Object.assign(this, {
      context: {
        ...this.context,
        targetAgentId,
      },
    });
  }

  static isInstance(error: unknown): error is Agent0DuplicateFeedbackError {
    return error instanceof Agent0DuplicateFeedbackError;
  }
}

/**
 * Error for Agent0 rate limiting
 */
export class Agent0RateLimitError extends RateLimitError {
  constructor(public readonly retryAfter?: number) {
    super(10, 60000, retryAfter); // 10 requests per minute default
  }

  static isInstance(error: unknown): error is Agent0RateLimitError {
    return error instanceof Agent0RateLimitError;
  }
}
