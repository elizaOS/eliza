/**
 * @module rate-limit
 * @description Helpers for detecting GitHub rate-limit errors and surfacing
 * them as structured results instead of raw exceptions.
 */

export interface GitHubHttpError {
  status?: number;
  response?: {
    headers?: Record<string, string | number | undefined>;
  };
  message?: string;
}

export interface RateLimitDetails {
  isRateLimited: boolean;
  resetAtMs: number | null;
  remaining: number | null;
}

function toErrorLike(value: unknown): GitHubHttpError {
  if (typeof value !== "object" || value === null) {
    return { message: String(value) };
  }
  return value as GitHubHttpError;
}

function headerNumber(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): number | null {
  if (!headers) {
    return null;
  }
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) {
    return null;
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function inspectRateLimit(
  err: unknown,
  nowMs: number = Date.now(),
): RateLimitDetails {
  const e = toErrorLike(err);
  const headers = e.response?.headers;
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const resetSeconds = headerNumber(headers, "x-ratelimit-reset");
  const retryAfterSeconds = headerNumber(headers, "retry-after");
  // A 429 always means "too many requests". A 403 counts only when GitHub says
  // the primary quota is spent (`x-ratelimit-remaining: 0`) or asks for a wait
  // (`retry-after`), which is how the secondary abuse limit answers while the
  // primary quota still has requests left. A plain 403 stays a permission
  // error.
  const isRateLimited =
    e.status === 429 ||
    (e.status === 403 && (remaining === 0 || retryAfterSeconds !== null));
  return {
    isRateLimited,
    remaining,
    // `retry-after` is a wait from now, so it is the precise answer for a
    // secondary limit; `x-ratelimit-reset` is the epoch second of the primary
    // window reset.
    resetAtMs:
      retryAfterSeconds !== null
        ? nowMs + retryAfterSeconds * 1000
        : resetSeconds === null
          ? null
          : resetSeconds * 1000,
  };
}

export function formatRateLimitMessage(details: RateLimitDetails): string {
  if (!details.isRateLimited) {
    return "GitHub request failed";
  }
  if (details.resetAtMs === null) {
    return "GitHub rate limit exhausted";
  }
  const reset = new Date(details.resetAtMs).toISOString();
  return `GitHub rate limit exhausted; resets at ${reset}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  const e = toErrorLike(err);
  return e.message ?? "unknown error";
}
