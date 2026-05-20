/**
 * Global error handler and middleware for API routes
 */

import * as BabylonDb from '@babylon/db';
import { logger, BabylonError as SharedBabylonError } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, BabylonError, isAuthenticationError } from './errors';
import type { JsonValue } from './types';

const DatabaseErrorCtor = (
  BabylonDb as { DatabaseError?: new (...args: unknown[]) => Error }
).DatabaseError;

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-vercel-oidc-token',
  'x-vercel-proxy-signature',
  'x-vercel-sc-headers',
]);

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const headersObj: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lowerKey)) {
      headersObj[key] = '[REDACTED]';
      return;
    }
    // Heuristic redaction for custom headers that may contain secrets
    if (/(token|secret|api[-_]?key|signature)/i.test(lowerKey)) {
      headersObj[key] = '[REDACTED]';
      return;
    }
    headersObj[key] = value;
  });
  return headersObj;
}

function serializeErrorCause(cause: unknown): Record<string, JsonValue> | null {
  if (!cause) return null;
  if (cause instanceof Error) {
    const anyCause = cause as Error & {
      code?: string;
      detail?: string;
      hint?: string;
    };
    const out: Record<string, JsonValue> = {
      name: anyCause.name,
      message: anyCause.message,
    };
    if (anyCause.code) out.code = anyCause.code;
    if (anyCause.detail) out.detail = anyCause.detail;
    if (anyCause.hint) out.hint = anyCause.hint;
    return out;
  }
  if (typeof cause === 'object') {
    // Best-effort: avoid serializing large/recursive objects
    return { message: String(cause) };
  }
  return { message: String(cause) };
}

const SENSITIVE_CONTEXT_KEY_PATTERN =
  /(token|secret|password|authorization|cookie|jwt|api[-_]?key|signature|session|credential|wallet|private[-_]?key)/i;

/**
 * Shallow-sanitizes a BabylonError context object before sending to Sentry.
 * Redacts values whose key matches sensitive patterns; preserves safe primitives.
 */
function sanitizeErrorContext(
  ctx: Record<string, JsonValue>
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (SENSITIVE_CONTEXT_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 200) {
      out[key] = `[string:${value.length}]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Options for error tracking and logging
 */
export interface ErrorHandlerOptions {
  /**
   * Function to track errors with analytics (e.g., PostHog)
   */
  trackError?: (
    userId: string | null,
    error: Error,
    context: Record<string, JsonValue>
  ) => void | Promise<void>;

  /**
   * Function to capture errors in error tracking (e.g., Sentry)
   */
  captureError?: (error: Error, context: Record<string, JsonValue>) => void;
}

let defaultErrorCapture: ErrorHandlerOptions['captureError'];

/**
 * Sets a global default error capture callback used by withErrorHandling.
 * Route-level options.captureError still takes precedence when provided.
 */
export function setDefaultErrorCapture(
  captureError?: ErrorHandlerOptions['captureError']
): void {
  defaultErrorCapture = captureError;
}

function resolveErrorHandlerOptions(
  options?: ErrorHandlerOptions
): ErrorHandlerOptions | undefined {
  if (options?.captureError) {
    return options;
  }

  if (!defaultErrorCapture) {
    return options;
  }

  return {
    ...options,
    captureError: defaultErrorCapture,
  };
}

/**
 * Main error handler that processes all errors and returns appropriate responses
 */
export function errorHandler(
  error: Error | unknown,
  request: NextRequest,
  options?: ErrorHandlerOptions
): NextResponse {
  // Log the error with context
  const errorContext = {
    url: request.url,
    method: request.method,
    headers: sanitizeHeaders(request.headers),
    timestamp: new Date().toISOString(),
  };

  // Handle unknown errors
  if (!(error instanceof Error)) {
    logger.error('Unknown error type', {
      error: String(error),
      ...errorContext,
    });

    // Best-effort capture for non-Error thrown values (rare, but can happen).
    if (options?.captureError) {
      const normalized = new Error(String(error));
      normalized.name = 'NonErrorThrown';
      options.captureError(normalized, {
        request: {
          url: request.url,
          method: request.method,
          headers: sanitizeHeaders(request.headers),
        },
        error: {
          message: String(error),
        },
      });
    }

    return NextResponse.json(
      {
        error: {
          message: 'An unexpected error occurred',
          code: 'UNKNOWN_ERROR',
        },
      },
      { status: 500 }
    );
  }

  // Handle authentication errors early - these are expected and shouldn't be logged as errors
  if (isAuthenticationError(error)) {
    // Skip logging for test tokens to reduce noise in test output
    const authHeader = request.headers.get('authorization');
    const isTestToken = authHeader?.includes('test-token');

    // Log authentication failures at warn level (expected behavior for unauthenticated requests)
    // But skip logging for test tokens
    if (!isTestToken) {
      logger.warn('Authentication failed', {
        error: error.message,
        ...errorContext,
      });
    }

    return NextResponse.json(
      {
        error: error.message || 'Authentication required',
      },
      { status: 401 }
    );
  }

  // Handle validation errors early - these are expected client input issues
  if (error instanceof z.ZodError) {
    // Skip logging for test tokens to reduce noise in test output
    const authHeader = request.headers.get('authorization');
    const isTestToken = authHeader?.includes('test-token');

    // Log validation errors at warn level (expected behavior for invalid client input)
    // But skip logging for test requests
    if (!isTestToken) {
      logger.warn('Validation error', {
        error: error.message,
        issues: error.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          path: issue.path.map(String),
        })),
        name: error.name,
        ...errorContext,
      });
    }

    return NextResponse.json(
      {
        error: 'Validation failed',
        details: error.issues.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      },
      { status: 400 }
    );
  }

  const userId = request.headers.get('x-user-id') || null;

  // Handle legacy/simple API errors used by many routes
  if (error instanceof ApiError) {
    if (error.statusCode >= 500) {
      logger.error('ApiError (5xx)', {
        error: error.message,
        code: error.code,
        statusCode: error.statusCode,
        ...errorContext,
      });

      if (options?.captureError) {
        try {
          options.captureError(error, {
            request: {
              url: new URL(request.url).pathname,
              method: request.method,
              headers: sanitizeHeaders(request.headers),
            },
            ...(userId ? { user: { id: userId } } : {}),
          });
        } catch (captureErr) {
          logger.warn('Error capture callback threw for ApiError', {
            error: String(captureErr),
          });
        }
      }
    } else {
      logger.warn('ApiError (4xx)', {
        error: error.message,
        code: error.code,
        statusCode: error.statusCode,
        ...errorContext,
      });
    }

    const errorData: Record<string, JsonValue> = { error: error.message };

    if (process.env.NODE_ENV === 'development') {
      if (error.code) {
        errorData.code = error.code;
      }
      if (error.stack) {
        errorData.stack = error.stack;
      }
    }

    return NextResponse.json(errorData, { status: error.statusCode });
  }

  // Handle client errors (4xx) at lower log level - these are expected behavior
  // Check both local BabylonError and @babylon/shared BabylonError (separate class hierarchies)
  const isLocalBabylonClient =
    error instanceof BabylonError &&
    error.statusCode >= 400 &&
    error.statusCode < 500;
  const isSharedBabylonClient =
    error instanceof SharedBabylonError &&
    error.statusCode >= 400 &&
    error.statusCode < 500;

  if (isLocalBabylonClient || isSharedBabylonClient) {
    logger.warn('Client error', {
      error: error.message,
      code: (error as BabylonError | SharedBabylonError).code,
      statusCode: (error as BabylonError | SharedBabylonError).statusCode,
      name: error.name,
      ...errorContext,
    });
  } else {
    const maybeCause = (error as Error & { cause?: unknown }).cause;
    logger.error('API Error', {
      error: error.message,
      stack: error.stack,
      name: error.name,
      cause: serializeErrorCause(maybeCause),
      ...errorContext,
    });
  }

  // Track error with analytics (async, don't await to avoid slowing down response)
  // Skip tracking authentication errors, validation errors, and 4xx client errors as they're expected behavior
  const isClientError = isLocalBabylonClient || isSharedBabylonClient;
  if (
    options?.trackError &&
    !isAuthenticationError(error) &&
    !(error instanceof z.ZodError) &&
    !isClientError
  ) {
    void options.trackError(userId, error, {
      endpoint: new URL(request.url).pathname,
      method: request.method,
    });
  }

  // Capture error in error tracking (only for server errors, not client errors like validation)
  // ZodError and AuthenticationError are excluded via early returns above.
  // BabylonError operational 4xx (e.g. ValidationError, BadRequestError) are excluded here.
  const isOperational4xx =
    (error instanceof BabylonError &&
      error.isOperational &&
      error.statusCode < 500) ||
    (error instanceof SharedBabylonError &&
      error.isOperational &&
      error.statusCode < 500);
  const shouldCaptureInErrorTracking =
    options?.captureError && error instanceof Error && !isOperational4xx;

  if (shouldCaptureInErrorTracking && options.captureError) {
    const context: Record<string, JsonValue> = {
      request: {
        url: new URL(request.url).pathname,
        method: request.method,
        headers: sanitizeHeaders(request.headers),
      },
    };
    if (userId) {
      context.user = { id: userId };
    }
    if (error instanceof BabylonError && error.context) {
      context.error = {
        context: sanitizeErrorContext(error.context),
        code: error.code,
      };
    } else if (error instanceof SharedBabylonError && error.context) {
      context.error = {
        context: sanitizeErrorContext(
          error.context as Record<string, JsonValue>
        ),
        code: error.code,
      };
    }
    try {
      options.captureError(error, context);
    } catch (captureErr) {
      logger.warn('Error capture callback threw', {
        error: String(captureErr),
      });
    }
  }

  // Handle Babylon errors (our custom errors)
  if (error instanceof BabylonError) {
    const errorData: Record<string, JsonValue> = { error: error.message };
    if (error.context?.details) {
      errorData.details = error.context.details as JsonValue;
    }
    if (process.env.NODE_ENV === 'development') {
      errorData.code = error.code;
      if (error.stack) {
        errorData.stack = error.stack;
      }
    }

    return NextResponse.json(errorData, {
      status: error.statusCode,
      headers:
        error.code === 'RATE_LIMIT' && error.context?.retryAfter
          ? { 'Retry-After': String(error.context.retryAfter) }
          : undefined,
    });
  }

  // Handle @babylon/shared domain errors (separate class hierarchy from local BabylonError)
  if (error instanceof SharedBabylonError) {
    const errorData: Record<string, JsonValue> = { error: error.message };
    if (error.context?.details) {
      errorData.details = error.context.details as JsonValue;
    }
    if (process.env.NODE_ENV === 'development') {
      errorData.code = error.code;
      if (error.stack) {
        errorData.stack = error.stack;
      }
    }

    return NextResponse.json(errorData, { status: error.statusCode });
  }

  // Handle database errors
  if (DatabaseErrorCtor && error instanceof DatabaseErrorCtor) {
    return handleDatabaseError(error as Error & { code?: string });
  }

  if (error instanceof Error) {
    // Handle native JavaScript errors
    if (error.name === 'SyntaxError') {
      return NextResponse.json(
        {
          error: 'Invalid JSON in request body',
        },
        { status: 400 }
      );
    }

    if (error.name === 'TypeError') {
      return NextResponse.json(
        {
          error:
            process.env.NODE_ENV === 'production'
              ? 'An unexpected error occurred'
              : error.message,
        },
        { status: 500 }
      );
    }

    // Default Error handling
    const errorData: Record<string, JsonValue> = {
      error:
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : error.message,
    };

    if (process.env.NODE_ENV === 'development' && error.stack) {
      errorData.stack = error.stack;
    }

    return NextResponse.json(errorData, { status: 500 });
  }

  // Handle any other unknown type
  return NextResponse.json(
    { error: 'An unexpected error occurred' },
    { status: 500 }
  );
}

/**
 * Handle database-specific errors
 * Uses PostgreSQL error codes (23xxx series for integrity constraints)
 */
function handleDatabaseError(error: Error & { code?: string }): NextResponse {
  const errorCode = 'code' in error ? error.code : undefined;
  switch (errorCode) {
    case '23505': // PostgreSQL unique_violation
      // Unique constraint violation
      return NextResponse.json(
        { error: 'A record with this value already exists' },
        { status: 409 }
      );

    case '23503': // PostgreSQL foreign_key_violation
      // Foreign key constraint failure
      return NextResponse.json(
        { error: 'Foreign key constraint failed' },
        { status: 400 }
      );

    case '23502': // PostgreSQL not_null_violation
      // Not null violation
      return NextResponse.json(
        { error: 'Required field is missing' },
        { status: 400 }
      );

    case '23514': // PostgreSQL check_violation
      // Check constraint violation
      return NextResponse.json(
        { error: 'Check constraint violation' },
        { status: 400 }
      );

    case '42P01': // PostgreSQL undefined_table
      // Table doesn't exist (migration not applied)
      logger.warn(
        `Database table missing: ${error.message}`,
        { code: errorCode },
        'DatabaseError'
      );
      return NextResponse.json(
        { error: 'Database migration pending. Please try again later.' },
        { status: 503 }
      );

    case '42703': // PostgreSQL undefined_column
      // Column doesn't exist (migration not applied)
      logger.warn(
        `Database column missing: ${error.message}`,
        { code: errorCode },
        'DatabaseError'
      );
      return NextResponse.json(
        { error: 'Database migration pending. Please try again later.' },
        { status: 503 }
      );

    default: {
      // Generic database error
      const dbErrorData: Record<string, JsonValue> = {
        error: 'Database operation failed',
      };
      if (process.env.NODE_ENV === 'development') {
        if (errorCode) {
          dbErrorData.code = errorCode;
        }
        dbErrorData.message = error.message;
      }
      return NextResponse.json(dbErrorData, { status: 500 });
    }
  }
}

/**
 * Route handler context type for Next.js API routes
 * Supports both sync and async (Promise) params for Next.js 14+
 */
export interface RouteContext {
  params?:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>;
}

/**
 * Higher-order function wrapper for API routes with error handling
 * @param handler The async route handler function
 * @param options Optional error handler options
 * @returns A wrapped handler with automatic error handling
 */
// Overload 1: Handler without context (for routes without dynamic params)
export function withErrorHandling(
  handler: (req: NextRequest) => Promise<Response> | Response,
  options?: ErrorHandlerOptions
): (req: NextRequest) => Promise<Response>;

// Overload 2: Handler with context (for routes with dynamic params)
export function withErrorHandling<TContext extends RouteContext = RouteContext>(
  handler: (
    req: NextRequest,
    context: TContext
  ) => Promise<Response> | Response,
  options?: ErrorHandlerOptions
): (req: NextRequest, context: TContext) => Promise<Response>;

// Implementation
export function withErrorHandling<TContext extends RouteContext = RouteContext>(
  handler: (
    req: NextRequest,
    context?: TContext
  ) => Promise<Response> | Response,
  options?: ErrorHandlerOptions
): (req: NextRequest, context?: TContext) => Promise<Response> {
  return async (req: NextRequest, context?: TContext): Promise<Response> => {
    try {
      const response = await handler(req, context!);
      return response;
    } catch (error) {
      return errorHandler(error, req, resolveErrorHandlerOptions(options));
    }
  };
}

/**
 * Async wrapper for route handlers with error boundaries
 * Useful for handlers that need setup or teardown
 */
export function asyncHandler<TContext extends RouteContext = RouteContext>(
  setup?: () => Promise<void>,
  handler?: (req: NextRequest, context?: TContext) => Promise<Response>,
  teardown?: () => Promise<void>,
  options?: ErrorHandlerOptions
): (req: NextRequest, context?: TContext) => Promise<Response> {
  return async (req: NextRequest, context?: TContext) => {
    try {
      if (setup) {
        await setup();
      }

      if (!handler) {
        throw new Error('Handler function is required');
      }

      const result = await handler(req, context);
      if (teardown) {
        await teardown();
      }
      return result;
    } catch (error) {
      return errorHandler(error, req, resolveErrorHandlerOptions(options));
    }
  };
}

/**
 * Type-safe error response helper
 */
export function errorResponse(
  message: string,
  code: string,
  statusCode: number,
  details?: Record<string, JsonValue>
): NextResponse {
  return NextResponse.json(
    {
      error: {
        message,
        code,
        ...details,
      },
    },
    { status: statusCode }
  );
}

/**
 * Success response helper
 */
export function successResponse<T>(
  data: T,
  statusCode = 200,
  headers?: HeadersInit
): NextResponse {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
  }

  const body = JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );

  if (body === undefined) {
    throw new TypeError('Value is not JSON serializable');
  }

  return new NextResponse(body, {
    status: statusCode,
    headers: responseHeaders,
  });
}
