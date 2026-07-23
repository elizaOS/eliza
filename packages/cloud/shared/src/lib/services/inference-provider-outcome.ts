/**
 * Classifies provider failures only when their wire status proves the request
 * was rejected before inference. Ambiguous transport and server failures stay
 * conservative because absence of output is not evidence of zero provider cost.
 */

import { APICallError, RetryError } from "ai";

const KNOWN_UNACCEPTED_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 409, 410, 413, 415, 422, 429,
]);

/** True only for an explicit provider response that rejects the request. */
export function isKnownUnacceptedProviderStatus(status: number): boolean {
  return KNOWN_UNACCEPTED_STATUSES.has(status);
}

/** True only for an explicit provider response that rejects the request. */
export function isKnownUnacceptedProviderError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current !== undefined; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const terminal = RetryError.isInstance(current) ? current.lastError : current;
    if (
      APICallError.isInstance(terminal) &&
      terminal.statusCode !== undefined &&
      isKnownUnacceptedProviderStatus(terminal.statusCode)
    ) {
      return true;
    }
    current = terminal instanceof Error && "cause" in terminal ? terminal.cause : undefined;
  }
  return false;
}

/**
 * True only for local provider configuration resolution that fails before an
 * upstream request can be accepted. Gateway timeout/5xx wrappers intentionally
 * do not qualify even though some UI boundaries describe them as unavailable.
 */
export function isKnownPreDispatchProviderConfigurationError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current !== undefined; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const terminal = RetryError.isInstance(current) ? current.lastError : current;
    if (terminal instanceof Error && terminal.name === "ProviderConfigurationError") {
      return true;
    }
    current = terminal instanceof Error && "cause" in terminal ? terminal.cause : undefined;
  }
  return false;
}
