/**
 * Session-specific error types for better error handling and debugging
 */

/**
 * Base class for all session-related errors
 */
export abstract class SessionError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: any;
  public readonly timestamp: Date;

  constructor(code: string, message: string, statusCode: number = 500, details?: any) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date();

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON for API responses
   */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        timestamp: this.timestamp.toISOString(),
        ...(process.env.NODE_ENV === 'development' && {
          details: this.details,
          stack: this.stack,
        }),
      },
    };
  }
}

/**
 * Error thrown when a session is not found
 */
export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string, details?: any) {
    super('SESSION_NOT_FOUND', `Session with ID '${sessionId}' not found`, 404, details);
  }
}

/**
 * Error thrown when a session has expired
 */
export class SessionExpiredError extends SessionError {
  constructor(sessionId: string, expiredAt?: Date, details?: any) {
    const message = expiredAt
      ? `Session '${sessionId}' expired at ${expiredAt.toISOString()}`
      : `Session '${sessionId}' has expired`;

    super('SESSION_EXPIRED', message, 410, details);
  }
}

/**
 * Error thrown when session creation fails
 */
export class SessionCreationError extends SessionError {
  constructor(reason: string, details?: any) {
    super('SESSION_CREATION_FAILED', `Failed to create session: ${reason}`, 500, details);
  }
}

/**
 * Error thrown when an agent is not found
 */
export class AgentNotFoundError extends SessionError {
  constructor(agentId: string, details?: any) {
    super('AGENT_NOT_FOUND', `Agent with ID '${agentId}' not found`, 404, details);
  }
}

/**
 * Error thrown when input validation fails
 */
export class ValidationError extends SessionError {
  public readonly field?: string;
  public readonly value?: any;

  constructor(message: string, field?: string, value?: any, details?: any) {
    super('VALIDATION_ERROR', message, 400, details);
    this.field = field;
    this.value = value;
  }
}

/**
 * Error thrown when a UUID is invalid
 */
export class InvalidUuidError extends ValidationError {
  constructor(field: string, value: string) {
    super(`Invalid UUID format for field '${field}'`, field, value, {
      providedValue: value,
      expectedFormat: 'UUID v4',
    });
  }
}

/**
 * Error thrown when required fields are missing
 */
export class MissingFieldsError extends ValidationError {
  constructor(fields: string[]) {
    super(`Missing required fields: ${fields.join(', ')}`, undefined, undefined, {
      missingFields: fields,
    });
  }
}

/**
 * Error thrown when content validation fails
 */
export class InvalidContentError extends ValidationError {
  constructor(reason: string, content?: any) {
    super(`Invalid content: ${reason}`, 'content', content, { reason });
  }
}

/**
 * Error thrown when metadata validation fails
 */
export class InvalidMetadataError extends ValidationError {
  constructor(reason: string, metadata?: any) {
    super(`Invalid metadata: ${reason}`, 'metadata', metadata, {
      reason,
      providedMetadata: metadata,
    });
  }
}

/**
 * Error thrown when pagination parameters are invalid
 */
export class InvalidPaginationError extends ValidationError {
  constructor(parameter: string, value: any, reason: string) {
    super(`Invalid pagination parameter '${parameter}': ${reason}`, parameter, value, {
      parameter,
      value,
      reason,
    });
  }
}

/**
 * Error thrown when timeout configuration is invalid
 */
export class InvalidTimeoutConfigError extends ValidationError {
  constructor(reason: string, config?: any) {
    super(`Invalid timeout configuration: ${reason}`, 'timeoutConfig', config, {
      reason,
      providedConfig: config,
    });
  }
}

/**
 * Error thrown when a session cannot be renewed
 */
export class SessionRenewalError extends SessionError {
  constructor(sessionId: string, reason: string, details?: any) {
    super('SESSION_RENEWAL_FAILED', `Cannot renew session '${sessionId}': ${reason}`, 400, details);
  }
}

/**
 * Error thrown when session deletion fails
 */
export class SessionDeletionError extends SessionError {
  constructor(sessionId: string, reason: string, details?: any) {
    super(
      'SESSION_DELETION_FAILED',
      `Failed to delete session '${sessionId}': ${reason}`,
      500,
      details
    );
  }
}

/**
 * Error thrown when message sending fails
 */
export class MessageSendError extends SessionError {
  constructor(sessionId: string, reason: string, details?: any) {
    super(
      'MESSAGE_SEND_FAILED',
      `Failed to send message in session '${sessionId}': ${reason}`,
      500,
      details
    );
  }
}

/**
 * Error thrown when message retrieval fails
 */
export class MessageRetrievalError extends SessionError {
  constructor(sessionId: string, reason: string, details?: any) {
    super(
      'MESSAGE_RETRIEVAL_FAILED',
      `Failed to retrieve messages for session '${sessionId}': ${reason}`,
      500,
      details
    );
  }
}

/**
 * Error thrown when database operations fail
 */
export class DatabaseError extends SessionError {
  constructor(operation: string, reason: string, details?: any) {
    super('DATABASE_ERROR', `Database operation '${operation}' failed: ${reason}`, 500, details);
  }
}

/**
 * Error thrown when session limit is exceeded
 */
export class SessionLimitExceededError extends SessionError {
  constructor(limit: number, current: number, details?: any) {
    super(
      'SESSION_LIMIT_EXCEEDED',
      `Session limit exceeded. Maximum: ${limit}, Current: ${current}`,
      429,
      details
    );
  }
}

/**
 * Error thrown when rate limit is exceeded
 */
export class RateLimitError extends SessionError {
  public readonly retryAfter?: number;

  constructor(message: string, retryAfter?: number, details?: any) {
    super('RATE_LIMIT_EXCEEDED', message, 429, details);
    this.retryAfter = retryAfter;
  }
}

/**
 * Error handler utility for Express middleware
 */
export function createErrorHandler() {
  return (err: Error, _req: any, res: any, next: any) => {
    // If response was already sent, delegate to default Express error handler
    if (res.headersSent) {
      return next(err);
    }

    // Handle SessionError instances
    if (err instanceof SessionError) {
      return res.status(err.statusCode).json(err.toJSON());
    }

    // Handle other known error types
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.message,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Log unexpected errors
    console.error('Unexpected error:', err);

    // Default error response
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString(),
        ...(process.env.NODE_ENV === 'development' && {
          details: err.message,
          stack: err.stack,
        }),
      },
    });
  };
}

/**
 * Type guard to check if an error is a SessionError
 */
export function isSessionError(error: unknown): error is SessionError {
  return error instanceof SessionError;
}

/**
 * Type guard to check if an error is a validation error
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}
