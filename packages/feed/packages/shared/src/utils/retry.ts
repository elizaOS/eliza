/**
 * Retry Utility for Async Operations
 *
 * @description Provides retry logic for async operations with exponential backoff.
 * Automatically retries on network errors, 5xx server errors, and rate limit (429) responses.
 */

import { logger } from "./logger";

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds before first retry (default: 100) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 2000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Optional callback for logging retry attempts */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry">> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};

/**
 * Check if error is retryable (network errors, 5xx, rate limits)
 *
 * @description Determines if an error should trigger a retry based on error type
 * and HTTP status code. Retries on network errors, 5xx server errors, and 429
 * rate limit responses.
 *
 * @param {unknown} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true; // Network errors
  }

  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    // Retry on 5xx errors and 429 (rate limit)
    return status >= 500 || status === 429;
  }

  return false;
}

/**
 * Sleep for specified milliseconds
 *
 * @description Creates a promise that resolves after the specified delay.
 * Used for exponential backoff delays between retry attempts.
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation if it fails with a retryable error
 *
 * @description Executes an async operation and automatically retries on retryable
 * errors (network errors, 5xx, 429) with exponential backoff. Throws immediately
 * on non-retryable errors.
 *
 * @template T - Return type of the operation
 * @param {() => Promise<T>} operation - Async operation to retry
 * @param {RetryOptions} options - Retry configuration options
 * @returns {Promise<T>} Result of the operation
 *
 * @example
 * ```typescript
 * const data = await retryIfRetryable(
 *   () => fetch('/api/data').then(r => r.json()),
 *   { maxAttempts: 5, initialDelayMs: 200 }
 * );
 * ```
 */
export async function retryIfRetryable<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      if (!isRetryableError(error)) {
        throw error; // Not retryable, throw immediately
      }

      // Don't retry if we've exhausted attempts
      if (attempt === opts.maxAttempts - 1) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        opts.initialDelayMs * opts.backoffMultiplier ** attempt,
        opts.maxDelayMs,
      );

      // Call optional retry callback
      options.onRetry?.(attempt + 1, lastError, delay);

      await sleep(delay);
    }
  }

  throw lastError || new Error("Operation failed with unknown error");
}

/**
 * Retry with custom retry condition
 *
 * @description Executes an async operation and retries based on a custom condition
 * function. Allows fine-grained control over which errors trigger retries.
 *
 * @template T - Return type of the operation
 * @param {() => Promise<T>} operation - Async operation to retry
 * @param {(error: unknown) => boolean} shouldRetry - Function that determines if error should retry
 * @param {RetryOptions} options - Retry configuration options
 * @returns {Promise<T>} Result of the operation
 *
 * @example
 * ```typescript
 * const result = await retryWithCondition(
 *   () => processData(),
 *   (error) => error instanceof CustomError && error.isRetryable,
 *   { maxAttempts: 3 }
 * );
 * ```
 */
export async function retryWithCondition<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (!shouldRetry(error)) {
        throw error;
      }

      if (attempt === opts.maxAttempts - 1) {
        throw error;
      }

      const delay = Math.min(
        opts.initialDelayMs * opts.backoffMultiplier ** attempt,
        opts.maxDelayMs,
      );

      // Call optional retry callback
      options.onRetry?.(attempt + 1, lastError, delay);

      await sleep(delay);
    }
  }

  throw lastError || new Error("Operation failed with unknown error");
}

/**
 * Configuration options for fire-and-forget retry operations.
 *
 * Shares common retry fields with `RetryOptions` (maxAttempts, initialDelayMs,
 * maxDelayMs, backoffMultiplier) but is specialized for fire-and-forget use cases:
 * - Omits `onRetry` callback (uses logging instead)
 * - Provides `logContext` and `metadata` for error logging
 * - Does not extend `RetryOptions` to keep the interfaces decoupled
 */
export interface FireAndForgetRetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds before first retry (default: 100) - aligned with RetryOptions */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 2000) - caps exponential backoff */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Context for logging (e.g., 'PerpOpen', 'PerpClose') */
  logContext?: string;
  /** Additional metadata to include in error logs */
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget async operation with retry
 *
 * @description Executes an async operation in the background with retry logic.
 * Only retries on retryable errors (network errors, 5xx, 429). Logs errors
 * after all retries are exhausted. Does not throw - meant for non-critical
 * side effects that shouldn't block the main flow.
 *
 * @param {() => Promise<void>} operation - Async operation to execute
 * @param {FireAndForgetRetryOptions} options - Configuration options
 *
 * @example
 * ```typescript
 * fireAndForgetWithRetry(
 *   () => handlePlayerTrade(userId, ticker, side, size),
 *   { logContext: 'PerpOpen', metadata: { userId, ticker } }
 * );
 * ```
 */
export function fireAndForgetWithRetry(
  operation: () => Promise<void>,
  options: FireAndForgetRetryOptions = {},
): void {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 2000,
    backoffMultiplier = 2,
    logContext = "FireAndForget",
    metadata = {},
  } = options;

  void (async () => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await operation();
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable - if not, log and exit immediately
        if (!isRetryableError(error)) {
          logger.error(
            "Fire-and-forget operation failed with non-retryable error",
            {
              // Spread metadata first; explicit properties (error, attempt) override metadata values
              ...metadata,
              error: lastError.message,
              attempt: attempt + 1,
            },
            logContext,
          );
          return; // Don't retry non-retryable errors
        }

        if (attempt < maxAttempts - 1) {
          // Exponential backoff with cap using shared sleep utility
          const delay = Math.min(
            initialDelayMs * backoffMultiplier ** attempt,
            maxDelayMs,
          );
          await sleep(delay);
        }
      }
    }

    // All retries exhausted - log as error for monitoring
    logger.error(
      "Fire-and-forget operation failed after retries",
      {
        // Spread metadata first; explicit properties (error, retriesAttempted) override metadata values
        ...metadata,
        error: lastError?.message ?? "Unknown error",
        retriesAttempted: maxAttempts,
      },
      logContext,
    );
  })();
}
