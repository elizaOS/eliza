import { createMiddleware } from "hono/factory";
import type { ApiResponse, AppVariables } from "../services/context";
import { isSensitivePath } from "./sensitive-paths";

const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMESTAMP_TTL_MS = 5 * 60 * 1000;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type RequestExpiryOptions = {
  required?: boolean;
  maxClockSkewMs?: number;
  timestampTtlMs?: number;
  now?: () => number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHttpTime(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function requestExpiry(options?: RequestExpiryOptions) {
  const required =
    options?.required ??
    (process.env.STEWARD_REQUIRE_REQUEST_EXPIRY === "true" ||
      (process.env.NODE_ENV === "production" &&
        process.env.STEWARD_ALLOW_STALE_SENSITIVE_REQUESTS !== "true"));
  const maxClockSkewMs =
    options?.maxClockSkewMs ??
    parsePositiveInt(
      process.env.STEWARD_REQUEST_EXPIRY_MAX_SKEW_MS,
      DEFAULT_MAX_CLOCK_SKEW_MS,
    );
  const timestampTtlMs =
    options?.timestampTtlMs ??
    parsePositiveInt(
      process.env.STEWARD_REQUEST_TIMESTAMP_TTL_MS,
      DEFAULT_TIMESTAMP_TTL_MS,
    );
  const now = options?.now ?? (() => Date.now());

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    if (
      !MUTATING_METHODS.has(c.req.method.toUpperCase()) ||
      !isSensitivePath(c.req.path)
    ) {
      return next();
    }

    const expiresAtHeader = c.req.header("X-Steward-Request-Expires-At");
    const timestampHeader = c.req.header("X-Steward-Request-Timestamp");

    if (!expiresAtHeader && !timestampHeader) {
      if (!required) return next();
      return c.json<ApiResponse>(
        { ok: false, error: "Request expiry header required" },
        400,
      );
    }

    const currentTime = now();
    const expiresAt = parseHttpTime(expiresAtHeader);
    if (expiresAtHeader && expiresAt === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid X-Steward-Request-Expires-At header" },
        400,
      );
    }
    if (expiresAt !== null) {
      if (expiresAt + maxClockSkewMs < currentTime) {
        return c.json<ApiResponse>(
          { ok: false, error: "Request has expired" },
          408,
        );
      }
      if (expiresAt - currentTime > timestampTtlMs + maxClockSkewMs) {
        return c.json<ApiResponse>(
          { ok: false, error: "Request expiry is too far in the future" },
          400,
        );
      }
    }

    const timestamp = parseHttpTime(timestampHeader);
    if (timestampHeader && timestamp === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid X-Steward-Request-Timestamp header" },
        400,
      );
    }
    if (timestamp !== null) {
      if (timestamp - currentTime > maxClockSkewMs) {
        return c.json<ApiResponse>(
          { ok: false, error: "Request timestamp is too far in the future" },
          400,
        );
      }
      if (currentTime - timestamp > timestampTtlMs + maxClockSkewMs) {
        return c.json<ApiResponse>(
          { ok: false, error: "Request timestamp is stale" },
          408,
        );
      }
    }

    return next();
  });
}

export const requireRequestExpiry = requestExpiry({ required: true });
