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
  "UND_ERR_BODY_TIMEOUT",
]);

const MAX_CAUSE_DEPTH = 10;

function checkDirectTimeout(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    const msg = error.toLowerCase();
    return msg.includes("timed out") || msg.includes("timeout");
  }
  if (typeof error === "object") {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
    };
    if (candidate.name === "TimeoutError") {
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
      if (msg.includes("timed out") || msg.includes("timeout")) {
        return true;
      }
    }
  }
  return false;
}

/** Classify an error as a fetch/AbortSignal/network timeout. */
export function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  let current: unknown = error;
  const visited = new Set<unknown>();
  let depth = 0;

  while (current && typeof current === "object" && depth < MAX_CAUSE_DEPTH) {
    if (visited.has(current)) break;
    visited.add(current);

    if (checkDirectTimeout(current)) {
      return true;
    }

    if ("cause" in current) {
      current = (current as { cause?: unknown }).cause;
      depth++;
    } else {
      break;
    }
  }

  if (typeof current === "string") {
    return checkDirectTimeout(current);
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
