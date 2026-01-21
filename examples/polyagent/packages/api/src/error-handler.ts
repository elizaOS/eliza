/**
 * Global error handler and middleware for API routes
 */

import { DatabaseError } from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApiError, isAuthenticationError, PolyagentError } from "./errors";
import type { JsonValue } from "./types";

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
    context: Record<string, JsonValue>,
  ) => void | Promise<void>;

  /**
   * Function to capture errors in error tracking (e.g., Sentry)
   */
  captureError?: (error: Error, context: Record<string, JsonValue>) => void;
}

/**
 * Main error handler that processes all errors and returns appropriate responses
 */
export function errorHandler(
  error: Error | unknown,
  request: NextRequest,
  options?: ErrorHandlerOptions,
): NextResponse {
  // Log the error with context
  const errorContext = {
    url: request.url,
    method: request.method,
    headers: (() => {
      const headersObj: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headersObj[key] = value;
      });
      return headersObj;
    })(),
    timestamp: new Date().toISOString(),
  };

  // Handle unknown errors
  if (!(error instanceof Error)) {
    logger.error("Unknown error type", {
      error: String(error),
      ...errorContext,
    });

    return NextResponse.json(
      {
        error: {
          message: "An unexpected error occurred",
          code: "UNKNOWN_ERROR",
        },
      },
      { status: 500 },
    );
  }

  // Handle authentication errors early - these are expected and shouldn't be logged as errors
  if (isAuthenticationError(error)) {
    // Skip logging for test tokens to reduce noise in test output
    const authHeader = request.headers.get("authorization");
    const isTestToken = authHeader?.includes("test-token");

    // Log authentication failures at warn level (expected behavior for unauthenticated requests)
    // But skip logging for test tokens
    if (!isTestToken) {
      logger.warn("Authentication failed", {
        error: error.message,
        ...errorContext,
      });
    }

    return NextResponse.json(
      {
        error: error.message || "Authentication required",
      },
      { status: 401 },
    );
  }

  // Handle validation errors early - these are expected client input issues
  if (error instanceof ZodError) {
    // Skip logging for test tokens to reduce noise in test output
    const authHeader = request.headers.get("authorization");
    const isTestToken = authHeader?.includes("test-token");

    // Log validation errors at warn level (expected behavior for invalid client input)
    // But skip logging for test requests
    if (!isTestToken) {
      logger.warn("Validation error", {
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
        error: "Validation failed",
        details: error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        })),
      },
      { status: 400 },
    );
  }

  // Handle legacy/simple API errors used by many routes
  if (error instanceof ApiError) {
    const errorData: Record<string, JsonValue> = { error: error.message };

    if (process.env.NODE_ENV === "development") {
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
  if (
    error instanceof PolyagentError &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    // Log 4xx client errors at warn level (expected behavior for invalid requests)
    logger.warn("Client error", {
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
      name: error.name,
      ...errorContext,
    });
  } else {
    // Log unexpected errors at ERROR level
    logger.error("API Error", {
      error: error.message,
      stack: error.stack,
      name: error.name,
      ...errorContext,
    });
  }

  // Track error with analytics (async, don't await to avoid slowing down response)
  // Skip tracking authentication errors, validation errors, and 4xx client errors as they're expected behavior
  const userId = request.headers.get("x-user-id") || null;
  const isClientError =
    error instanceof PolyagentError &&
    error.statusCode >= 400 &&
    error.statusCode < 500;
  if (
    options?.trackError &&
    !isAuthenticationError(error) &&
    !(error instanceof ZodError) &&
    !isClientError
  ) {
    void options.trackError(userId, error, {
      endpoint: new URL(request.url).pathname,
      method: request.method,
    });
  }

  // Capture error in error tracking (only for server errors, not client errors like validation)
  // Skip capturing validation errors, authentication errors, and known operational errors
  const shouldCaptureInErrorTracking =
    options?.captureError &&
    error instanceof Error &&
    !(error instanceof ZodError) &&
    !(
      error instanceof PolyagentError &&
      error.isOperational &&
      error.statusCode < 500
    ) &&
    !isAuthenticationError(error) &&
    error.name !== "ValidationError";

  if (shouldCaptureInErrorTracking && options.captureError) {
    const context: Record<string, JsonValue> = {
      request: {
        url: request.url,
        method: request.method,
        headers: (() => {
          const headersObj: Record<string, string> = {};
          request.headers.forEach((value, key) => {
            headersObj[key] = value;
          });
          return headersObj;
        })(),
      },
    };
    if (userId) {
      context.user = { id: userId };
    }
    if (error instanceof PolyagentError && error.context) {
      context.error = { context: error.context, code: error.code };
    }
    options.captureError(error, context);
  }

  // Handle Polyagent errors (our custom errors)
  if (error instanceof PolyagentError) {
    const errorData: Record<string, JsonValue> = { error: error.message };
    if (error.context?.details) {
      errorData.details = error.context.details as JsonValue;
    }
    if (process.env.NODE_ENV === "development") {
      errorData.code = error.code;
      if (error.stack) {
        errorData.stack = error.stack;
      }
    }

    return NextResponse.json(errorData, {
      status: error.statusCode,
      headers:
        error.code === "RATE_LIMIT" && error.context?.retryAfter
          ? { "Retry-After": String(error.context.retryAfter) }
          : undefined,
    });
  }

  // Handle database errors
  if (error instanceof DatabaseError) {
    return handleDatabaseError(error);
  }

  if (error instanceof Error) {
    // Handle native JavaScript errors
    if (error.name === "SyntaxError") {
      return NextResponse.json(
        {
          error: "Invalid JSON in request body",
        },
        { status: 400 },
      );
    }

    if (error.name === "TypeError") {
      return NextResponse.json(
        {
          error:
            process.env.NODE_ENV === "production"
              ? "An unexpected error occurred"
              : error.message,
        },
        { status: 500 },
      );
    }

    // Default Error handling
    const errorData: Record<string, JsonValue> = {
      error:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred"
          : error.message,
    };

    if (process.env.NODE_ENV === "development" && error.stack) {
      errorData.stack = error.stack;
    }

    return NextResponse.json(errorData, { status: 500 });
  }

  // Handle any other unknown type
  return NextResponse.json(
    { error: "An unexpected error occurred" },
    { status: 500 },
  );
}

/**
 * Handle database-specific errors
 * Uses PostgreSQL error codes (23xxx series for integrity constraints)
 */
function handleDatabaseError(
  error: DatabaseError & { code?: string },
): NextResponse {
  const errorCode = "code" in error ? error.code : undefined;
  switch (errorCode) {
    case "23505": // PostgreSQL unique_violation
      // Unique constraint violation
      return NextResponse.json(
        { error: "A record with this value already exists" },
        { status: 409 },
      );

    case "23503": // PostgreSQL foreign_key_violation
      // Foreign key constraint failure
      return NextResponse.json(
        { error: "Foreign key constraint failed" },
        { status: 400 },
      );

    case "23502": // PostgreSQL not_null_violation
      // Not null violation
      return NextResponse.json(
        { error: "Required field is missing" },
        { status: 400 },
      );

    case "23514": // PostgreSQL check_violation
      // Check constraint violation
      return NextResponse.json(
        { error: "Check constraint violation" },
        { status: 400 },
      );

    case "42P01": // PostgreSQL undefined_table
      // Table doesn't exist (migration not applied)
      logger.warn(
        `Database table missing: ${error.message}`,
        { code: errorCode },
        "DatabaseError",
      );
      return NextResponse.json(
        { error: "Database migration pending. Please try again later." },
        { status: 503 },
      );

    case "42703": // PostgreSQL undefined_column
      // Column doesn't exist (migration not applied)
      logger.warn(
        `Database column missing: ${error.message}`,
        { code: errorCode },
        "DatabaseError",
      );
      return NextResponse.json(
        { error: "Database migration pending. Please try again later." },
        { status: 503 },
      );

    default: {
      // Generic database error
      const dbErrorData: Record<string, JsonValue> = {
        error: "Database operation failed",
      };
      if (process.env.NODE_ENV === "development") {
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
  handler: (req: NextRequest) => Promise<NextResponse> | NextResponse,
  options?: ErrorHandlerOptions,
): (req: NextRequest) => Promise<NextResponse>;

// Overload 2: Handler with context (for routes with dynamic params)
export function withErrorHandling<TContext extends RouteContext = RouteContext>(
  handler: (
    req: NextRequest,
    context: TContext,
  ) => Promise<NextResponse> | NextResponse,
  options?: ErrorHandlerOptions,
): (req: NextRequest, context: TContext) => Promise<NextResponse>;

// Implementation
export function withErrorHandling<TContext extends RouteContext = RouteContext>(
  handler: (
    req: NextRequest,
    context?: TContext,
  ) => Promise<NextResponse> | NextResponse,
  options?: ErrorHandlerOptions,
): (req: NextRequest, context?: TContext) => Promise<NextResponse> {
  return async (
    req: NextRequest,
    context?: TContext,
  ): Promise<NextResponse> => {
    try {
      const response = await handler(req, context!);
      return response;
    } catch (error) {
      return errorHandler(error, req, options);
    }
  };
}

/**
 * Async wrapper for route handlers with error boundaries
 * Useful for handlers that need setup or teardown
 */
export function asyncHandler<TContext extends RouteContext = RouteContext>(
  setup?: () => Promise<void>,
  handler?: (req: NextRequest, context?: TContext) => Promise<NextResponse>,
  teardown?: () => Promise<void>,
): (req: NextRequest, context?: TContext) => Promise<NextResponse> {
  return async (req: NextRequest, context?: TContext) => {
    try {
      if (setup) {
        await setup();
      }

      if (!handler) {
        throw new Error("Handler function is required");
      }

      const result = await handler(req, context);
      if (teardown) {
        await teardown();
      }
      return result;
    } catch (error) {
      return errorHandler(error, req);
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
  details?: Record<string, JsonValue>,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        message,
        code,
        ...details,
      },
    },
    { status: statusCode },
  );
}

/**
 * Success response helper
 */
export function successResponse<T>(
  data: T,
  statusCode = 200,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(data, { status: statusCode, headers });
}
