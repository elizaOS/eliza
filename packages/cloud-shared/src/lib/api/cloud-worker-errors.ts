/**
 * Canonical JSON error helpers for the Cloud API Worker (Hono).
 *
 * Shape matches `packages/lib/api/errors.ts` `ApiError.toJSON()`:
 * { success: false, error: <message>, code: <code>, details?: ... }
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export type ApiErrorCode =
  | "authentication_required"
  | "session_auth_required"
  | "invalid_credentials"
  | "access_denied"
  | "resource_not_found"
  | "rate_limit_exceeded"
  | "validation_error"
  | "insufficient_credits"
  | "session_not_ready"
  | "internal_error";

export interface ApiErrorOptions {
  code: ApiErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export class ApiError extends HTTPException {
  public readonly code: ApiErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusOrOptions: number | ApiErrorOptions,
    code?: ApiErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    const options =
      typeof statusOrOptions === "number"
        ? {
            status: statusOrOptions,
            code: code ?? inferCodeFromStatus(statusOrOptions),
            message: message ?? "Request failed",
            details,
          }
        : statusOrOptions;

    super(options.status as 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 503, {
      message: options.message,
    });
    this.name = "ApiError";
    this.code = options.code;
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

export const AuthenticationError = (message = "Authentication required") =>
  new ApiError(401, "authentication_required", message);

export const ForbiddenError = (message = "Access denied") =>
  new ApiError(403, "access_denied", message);

export const NotFoundError = (message = "Resource not found") =>
  new ApiError(404, "resource_not_found", message);

export const ValidationError = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, "validation_error", message, details);

export const RateLimitError = (retryAfter?: number) =>
  new ApiError(
    429,
    "rate_limit_exceeded",
    "Rate limit exceeded",
    retryAfter ? { retryAfter } : undefined,
  );

function inferCodeFromStatus(status: number): ApiErrorCode {
  if (status === 401) return "authentication_required";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "access_denied";
  if (status === 404) return "resource_not_found";
  if (status === 409) return "session_not_ready";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 422 || status === 400) return "validation_error";
  return "internal_error";
}

function safeUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const status = inferStatusFromLegacyError(error);
    if (status < 500) return error.message;
  }
  return "An unexpected error occurred";
}

function inferStatusFromLegacyError(error: Error): number {
  const message = error.message.toLowerCase();
  if (error.name === "InsufficientCreditsError") return 402;
  if (error.name === "AuthenticationError" || error.name === "UnauthorizedError") return 401;
  if (error.name === "ForbiddenError" || error.name === "AccessDeniedError") return 403;
  if (error.name === "NotFoundError") return 404;
  if (error.name === "RateLimitError") return 429;
  if (
    message.includes("password authentication failed") ||
    message.includes("authentication failed for user")
  ) {
    return 500;
  }
  if (
    message.includes("invalid api key") ||
    message.includes("invalid token") ||
    message.includes("invalid credentials") ||
    message.includes("invalid service key")
  ) {
    return 401;
  }
  if (
    message.includes("requires authentication") ||
    message.includes("requires authorization") ||
    message.includes("requires admin") ||
    message.includes("requires owner") ||
    message.includes("requires org membership")
  ) {
    return 403;
  }
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
    message.includes("permission") ||
    (message.includes("organization") && message.includes("inactive"))
  ) {
    return 403;
  }
  if (message.includes("not found")) return 404;
  if (message.includes("rate limit")) return 429;
  if (message.includes("not ready")) return 409;
  return 500;
}

export function jsonError(
  c: Context,
  status: number,
  message: string,
  code?: ApiErrorCode,
  details?: Record<string, unknown>,
): Response {
  return c.json(
    {
      success: false,
      error: message,
      code: code ?? inferCodeFromStatus(status),
      ...(details && { details }),
    },
    status as 400,
  );
}

/** Convert any thrown error to a JSON response matching the canonical shape. */
export function failureResponse(c: Context, error: unknown): Response {
  if (error instanceof ZodError) {
    return c.json(
      {
        success: false,
        error: "Validation failed",
        code: "validation_error" as const,
        details: { issues: error.issues },
      },
      400,
    );
  }
  if (error instanceof ApiError) {
    return c.json(error.toJSON(), error.status as 400);
  }
  if (error instanceof HTTPException) {
    return c.json(
      {
        success: false,
        error: error.message || "Request failed",
        code: inferCodeFromStatus(error.status),
      },
      error.status as 400,
    );
  }
  const status = error instanceof Error ? inferStatusFromLegacyError(error) : 500;
  return c.json(
    {
      success: false,
      error: safeUnknownErrorMessage(error),
      code: inferCodeFromStatus(status),
    },
    status as 400,
  );
}
