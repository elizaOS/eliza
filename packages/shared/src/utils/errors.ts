/**
 * Shared error classification helpers.
 *
 * Consolidates the timeout detection pattern that was independently
 * implemented in cloud-routes.ts and cloud-connection.ts.
 */

import { formatError } from "@elizaos/core";

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "ABORT_ERR",
]);

/** Classify an error as a fetch/AbortSignal timeout. */
export function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TIMEOUT_CODES.has(code)) {
      return true;
    }
    const msg = error.message.toLowerCase();
    return msg.includes("timed out") || msg.includes("timeout");
  }
  if (typeof error === "object") {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
    };
    if (candidate.name === "TimeoutError" || candidate.name === "AbortError") {
      return true;
    }
    if (
      typeof candidate.code === "string" &&
      TIMEOUT_CODES.has(candidate.code)
    ) {
      return true;
    }
    if (typeof candidate.message === "string") {
      const msg = candidate.message.toLowerCase();
      return msg.includes("timed out") || msg.includes("timeout");
    }
  }
  if (typeof error === "string") {
    const msg = error.toLowerCase();
    return msg.includes("timed out") || msg.includes("timeout");
  }
  return false;
}

/** Classify a fetch Response as a redirect (3xx). */
export function isRedirectResponse(response: Response): boolean {
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.status !== "number" ||
    !Number.isFinite(response.status)
  ) {
    return false;
  }
  return response.status >= 300 && response.status < 400;
}

/** Extract a human-readable message from an unknown caught value. */
export const errorMessage = formatError;
