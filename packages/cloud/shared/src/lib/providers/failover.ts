/**
 * Retryable-upstream classification shared by the provider HTTP clients and the
 * AI-SDK fallback middleware in `language-model.ts`.
 */

import type { ProviderHttpError } from "./types";

/**
 * Upstream HTTP statuses worth retrying on a different provider or routing path:
 * payment/capacity (402, 429) and gateway/outage (5xx). Shared by the
 * `ProviderHttpError` classification here and the AI-SDK routing-suffix failover in
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
