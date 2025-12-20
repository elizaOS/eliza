/**
 * Retry helpers for tests
 *
 * Provides retry logic with configurable backoff strategies.
 */

export type BackoffStrategy = 'constant' | 'linear' | 'exponential';

export interface RetryOptions {
  /**
   * Maximum number of attempts (including first try)
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Initial delay in ms
   * @default 100
   */
  initialDelay?: number;

  /**
   * Maximum delay in ms (prevents exponential from growing too large)
   * @default 10000
   */
  maxDelay?: number;

  /**
   * Backoff strategy
   * @default 'exponential'
   */
  backoff?: BackoffStrategy;

  /**
   * Optional callback called on each retry
   */
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Retry an async function with configurable backoff
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Promise<T> - Result of successful function call
 * @throws Error - Last error if all attempts fail
 *
 * @example
 * ```typescript
 * const data = await retry(
 *   () => fetch('http://localhost:5000/api/agents'),
 *   { maxAttempts: 5, backoff: 'exponential' }
 * );
 * ```
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 100,
    maxDelay = 10000,
    backoff = 'exponential',
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on last attempt
      if (attempt === maxAttempts - 1) {
        break;
      }

      // Call retry callback
      if (onRetry) {
        onRetry(attempt + 1, lastError);
      }

      // Calculate delay based on backoff strategy
      const delay = calculateDelay(attempt, initialDelay, backoff, maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('Retry failed without error');
}

/**
 * Calculate delay for next retry based on backoff strategy
 */
function calculateDelay(
  attempt: number,
  initialDelay: number,
  backoff: BackoffStrategy,
  maxDelay: number
): number {
  let delay: number;

  switch (backoff) {
    case 'constant':
      delay = initialDelay;
      break;

    case 'linear':
      delay = initialDelay * (attempt + 1);
      break;

    case 'exponential':
      delay = initialDelay * Math.pow(2, attempt);
      break;

    default:
      delay = initialDelay;
  }

  return Math.min(delay, maxDelay);
}
