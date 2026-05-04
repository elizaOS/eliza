/**
 * Canonical JSON error helpers for the Cloud API Worker (Hono).
 *
 * Shape matches `packages/lib/api/errors.ts` `ApiError.toJSON()`:
 * { success: false, error: <message>, code: <code>, details?: ... }
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { caughtErrorJson } from "./errors";

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

export class ApiError extends HTTPException {
  public readonly code: ApiErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(status as 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500, { message });
    this.code = code;
    this.details = details;
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
  const translated = caughtErrorJson(error);
  return c.json(translated.body, translated.status as 400);
}
