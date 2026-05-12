/**
 * Provider failover utility.
 *
 * Catches retryable errors (402 Payment Required, 429 Rate Limited) from
 * the primary provider and retries the request with a fallback provider.
 */

import { logger } from "@/lib/utils/logger";
import type { ProviderHttpError } from "./types";

/**
 * Whether a provider error is retryable via fallback.
 * Matches the structured `{ status, error }` shape (`ProviderHttpError`)
 * thrown by every provider implementation (OpenRouter, OpenAI direct,
 * Anthropic direct, Groq).
 */
function isRetryableProviderError(error: unknown): error is ProviderHttpError {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    return status === 402 || status === 429;
  }
  return false;
}

/**
 * Execute `primaryFn`. On a retryable provider error (402/429),
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
