/**
 * Provider failover utility.
 *
 * Catches retryable capacity/outage errors from the primary provider and
 * retries the request with a fallback provider.
 */

import { logger } from "../utils/logger";
import type { ProviderHttpError } from "./types";

/**
 * Upstream HTTP statuses worth retrying on a different provider or routing path:
 * payment/capacity (402, 429) and gateway/outage (5xx). Shared by the
 * `ProviderHttpError` failover here and the AI-SDK routing-suffix failover in
 * `language-model.ts`.
 */
export const RETRYABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([
  402, 429, 500, 502, 503, 504,
]);

/**
 * Whether a provider error is retryable via fallback.
 * Matches the structured `{ status, error }` shape (`ProviderHttpError`)
 * thrown by every provider implementation (BitRouter, OpenAI direct,
 * Anthropic direct, Groq).
 */
export function isRetryableProviderError(error: unknown): error is ProviderHttpError {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" && RETRYABLE_UPSTREAM_STATUSES.has(status);
  }
  return false;
}

/**
 * Execute `primaryFn`. On a retryable provider error,
 * log a warning and execute `fallbackFn` instead.
 */
export async function withProviderFallback(
  primaryFn: () => Promise<Response>,
  fallbackFn: (() => Promise<Response>) | null,
): Promise<Response> {
  try {
    return await primaryFn();
  } catch (error) {
    if (fallbackFn && isRetryableProviderError(error)) {
      logger.warn(
        "[Provider Failover] Primary provider returned %d, trying fallback",
        error.status,
      );
      return await fallbackFn();
    }
    throw error;
  }
}
