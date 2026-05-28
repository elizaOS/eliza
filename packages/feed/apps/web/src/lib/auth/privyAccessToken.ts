/**
 * Access token retry utilities.
 *
 * Originally written for Privy; now used with Steward tokens via the compat shim.
 * TODO: Phase 3 - rename this file to `accessToken.ts` and remove Privy naming.
 */
import { extractErrorMessage, sleep } from "@feed/shared";

const RETRYABLE_ACCESS_TOKEN_ERROR_MESSAGES = [
  "failed to fetch",
  "fetch failed",
  "load failed",
  "networkerror",
  "network request failed",
  "timed out",
  "timeout",
  "session",
] as const;

export interface AccessTokenRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface SafeAccessTokenOptions extends AccessTokenRetryOptions {
  onError?: (error: Error) => void;
}

function normalizeAccessTokenError(error: unknown): Error {
  return error instanceof Error ? error : new Error(extractErrorMessage(error));
}

export function isRetryableAccessTokenError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return error.message.toLowerCase().includes("fetch");
  }

  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return status === 408 || status === 429 || status >= 500;
    }
  }

  const message = normalizeAccessTokenError(error).message.toLowerCase();

  return RETRYABLE_ACCESS_TOKEN_ERROR_MESSAGES.some((pattern) =>
    message.includes(pattern),
  );
}

export async function getAccessTokenWithRetry(
  getAccessToken: () => Promise<string | null>,
  options: AccessTokenRetryOptions = {},
): Promise<string | null> {
  const {
    maxAttempts = 3,
    initialDelayMs = 250,
    maxDelayMs = 1000,
    backoffMultiplier = 2,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await getAccessToken();
    } catch (error) {
      lastError = normalizeAccessTokenError(error);

      if (!isRetryableAccessTokenError(error) || attempt === maxAttempts - 1) {
        throw lastError;
      }

      const delayMs = Math.min(
        initialDelayMs * backoffMultiplier ** attempt,
        maxDelayMs,
      );
      onRetry?.(attempt + 1, lastError, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Failed to fetch access token");
}

export async function getAccessTokenSafely(
  getAccessToken: () => Promise<string | null>,
  options: SafeAccessTokenOptions = {},
): Promise<string | null> {
  const { onError, ...retryOptions } = options;

  try {
    return await getAccessTokenWithRetry(getAccessToken, retryOptions);
  } catch (error) {
    onError?.(normalizeAccessTokenError(error));
    return null;
  }
}

// Deprecated aliases for backward compatibility.

/** @deprecated Use `AccessTokenRetryOptions` */
export type PrivyAccessTokenRetryOptions = AccessTokenRetryOptions;
/** @deprecated Use `SafeAccessTokenOptions` */
export type SafePrivyAccessTokenOptions = SafeAccessTokenOptions;
/** @deprecated Use `isRetryableAccessTokenError` */
export const isRetryablePrivyAccessTokenError = isRetryableAccessTokenError;
/** @deprecated Use `getAccessTokenWithRetry` */
export const getPrivyAccessTokenWithRetry = getAccessTokenWithRetry;
/** @deprecated Use `getAccessTokenSafely` */
export const getPrivyAccessTokenSafely = getAccessTokenSafely;
