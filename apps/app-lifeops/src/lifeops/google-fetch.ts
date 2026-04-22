import { logger } from "@elizaos/core";
import { GoogleApiError } from "./google-api-error.js";

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;
const TIMEOUT_MS = 10_000;

/**
 * Rewrite Google API hostnames to a mock base when MILADY_MOCK_GOOGLE_BASE is set.
 * Used in tests to point all Google API traffic at a Mockoon environment.
 */
export function rewriteGoogleUrlForMock(url: string): string {
  const mockBase = process.env.MILADY_MOCK_GOOGLE_BASE;
  if (!mockBase) return url;
  return url.replace(
    /^https:\/\/(?:gmail|www|oauth2|openidconnect|sheets|docs|fitness)\.googleapis\.com|^https:\/\/accounts\.google\.com/,
    mockBase.replace(/\/+$/, ""),
  );
}

/**
 * Returns `true` for HTTP statuses that are worth retrying (5xx, 429).
 * 4xx errors (other than 429) are permanent — auth failures, bad requests, etc.
 */
function isTransientStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500;
}

function isGoogleGmailWrite(method: string, url: string): boolean {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase())) {
    return false;
  }
  return /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\//.test(url);
}

function guardRealGmailWrite(method: string, originalUrl: string, targetUrl: string): void {
  if (!isGoogleGmailWrite(method, originalUrl)) {
    return;
  }
  if (process.env.MILADY_ALLOW_REAL_GMAIL_WRITES === "1") {
    return;
  }
  if (targetUrl !== originalUrl) {
    return;
  }
  if (process.env.MILADY_BLOCK_REAL_GMAIL_WRITES === "1") {
    throw new GoogleApiError(
      409,
      "Real Gmail writes are disabled by MILADY_BLOCK_REAL_GMAIL_WRITES. Point MILADY_MOCK_GOOGLE_BASE at Mockoon or set MILADY_ALLOW_REAL_GMAIL_WRITES=1 for an explicitly confirmed real write.",
    );
  }
}

/**
 * Fetch wrapper for Google APIs with retry, timeout, and structured logging.
 *
 * - 10-second `AbortSignal.timeout` per attempt
 * - Up to 2 retries with exponential backoff (1s, 2s) on transient failures
 * - Fails fast on 4xx (except 429)
 * - Returns the successful `Response` for caller to parse
 * - Throws `GoogleApiError` on permanent failure or exhausted retries
 */
export async function googleApiFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? "GET";
  const targetUrl = rewriteGoogleUrlForMock(url);
  guardRealGmailWrite(method, url, targetUrl);
  let lastError: GoogleApiError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        {
          boundary: "lifeops",
          integration: "google",
          method,
          attempt,
          delayMs,
        },
        `[lifeops] Google API retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      const response = await fetch(targetUrl, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.ok) {
        return response;
      }

      // Read the error body for context
      const errorText = await response.text().catch(() => "");
      let errorMessage: string;
      try {
        const parsed = JSON.parse(errorText) as {
          error?: { message?: string };
        };
        errorMessage =
          parsed.error?.message || errorText || `HTTP ${response.status}`;
      } catch {
        errorMessage = errorText || `HTTP ${response.status}`;
      }

      lastError = new GoogleApiError(response.status, errorMessage);

      if (!isTransientStatus(response.status)) {
        throw lastError;
      }

      logger.warn(
        {
          boundary: "lifeops",
          integration: "google",
          method,
          statusCode: response.status,
          attempt,
        },
        `[lifeops] Google API transient error: ${errorMessage}`,
      );
    } catch (error) {
      if (error instanceof GoogleApiError) {
        throw error;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(
        {
          boundary: "lifeops",
          integration: "google",
          method,
          attempt,
        },
        `[lifeops] Google API network error: ${errorMsg}`,
      );
      lastError = new GoogleApiError(0, errorMsg);
    }
  }

  throw lastError ?? new GoogleApiError(0, "Google API request failed");
}
