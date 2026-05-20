/**
 * Error Utilities
 *
 * Provides consistent error handling patterns across the engine package.
 * Ensures errors are properly formatted, logged, and propagated.
 */

import { logger } from '@babylon/shared';

/**
 * Safely extract error message from an unknown error value.
 * Handles Error objects, strings, and other types.
 *
 * @param error - The caught error value
 * @returns A string representation of the error
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Safely extract error with stack trace if available.
 *
 * @param error - The caught error value
 * @returns Object with message and optional stack
 */
export function formatErrorWithStack(error: unknown): {
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: formatError(error) };
}

/**
 * Log error and rethrow. Useful for catch blocks that need to log but not swallow.
 *
 * @param error - The caught error value
 * @param context - Description of where the error occurred
 * @param service - Service name for logging
 * @throws Always throws the original error
 */
export function logAndRethrow(
  error: unknown,
  context: string,
  service = 'Engine'
): never {
  const { message, stack } = formatErrorWithStack(error);
  logger.error(context, { error: message, stack }, service);
  throw error;
}

/**
 * Log error without rethrowing. Useful for non-critical operations.
 *
 * @param error - The caught error value
 * @param context - Description of where the error occurred
 * @param service - Service name for logging
 */
export function logError(
  error: unknown,
  context: string,
  service = 'Engine'
): void {
  const { message, stack } = formatErrorWithStack(error);
  logger.error(context, { error: message, stack }, service);
}

/**
 * Log warning without rethrowing. Useful for recoverable errors.
 *
 * @param error - The caught error value
 * @param context - Description of where the error occurred
 * @param service - Service name for logging
 */
export function logWarning(
  error: unknown,
  context: string,
  service = 'Engine'
): void {
  logger.warn(context, { error: formatError(error) }, service);
}

/**
 * Type guard to check if an error has a specific error code.
 * Useful for handling database or API-specific errors.
 *
 * @param error - The caught error value
 * @param code - The error code to check for
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code: unknown }).code === code;
  }
  return false;
}

/**
 * Check if an error is a transient error that may succeed on retry.
 * Checks for common transient error patterns.
 *
 * @param error - The caught error value
 * @returns True if the error is likely transient
 */
export function isTransientError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();

  // Common transient error patterns
  const transientPatterns = [
    'timeout',
    'timed out',
    'connection reset',
    'connection refused',
    'econnreset',
    'econnrefused',
    'etimedout',
    'network error',
    'temporary',
    'too many requests',
    'rate limit',
    'service unavailable',
    '503',
    '429',
    'busy',
    'overloaded',
  ];

  return transientPatterns.some((pattern) => message.includes(pattern));
}

/**
 * Wrap an async operation with error handling that logs but doesn't throw.
 * Returns null on error. Useful for non-critical operations.
 *
 * @param operation - The async operation to execute
 * @param context - Description of the operation for logging
 * @param service - Service name for logging
 * @returns The result or null on error
 */
export async function safeExecute<T>(
  operation: () => Promise<T>,
  context: string,
  service = 'Engine'
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    logWarning(error, `${context} (non-blocking)`, service);
    return null;
  }
}

/**
 * Handle non-critical operations that should not break the main flow.
 * Logs errors and returns null on failure, allowing the caller to continue.
 *
 * DRY pattern for game-tick.ts and other orchestrators with many non-critical operations.
 *
 * @param operation - The async operation to execute
 * @param context - Description of the operation for logging
 * @param service - Service name for logging
 * @returns The result or null on error
 *
 * @example
 * ```typescript
 * const result = await handleNonCritical(
 *   () => processNPCSocialEngagements({ now: timestamp }),
 *   'NPC social engagement',
 *   'GameTick'
 * );
 * if (result) {
 *   // Use result
 * }
 * ```
 */
export async function handleNonCritical<T>(
  operation: () => Promise<T>,
  context: string,
  service = 'Engine'
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    logger.error(context, { error: formatError(error) }, service);
    return null;
  }
}

/**
 * Handle non-critical operations with a default value on failure.
 * Similar to handleNonCritical but returns a default instead of null.
 *
 * @param operation - The async operation to execute
 * @param defaultValue - Value to return on error
 * @param context - Description of the operation for logging
 * @param service - Service name for logging
 * @returns The result or defaultValue on error
 */
export async function handleNonCriticalWithDefault<T>(
  operation: () => Promise<T>,
  defaultValue: T,
  context: string,
  service = 'Engine'
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logger.error(context, { error: formatError(error) }, service);
    return defaultValue;
  }
}

/**
 * Wrap an async operation with retry logic for transient errors.
 *
 * @param operation - The async operation to execute
 * @param maxRetries - Maximum number of retry attempts
 * @param context - Description of the operation for logging
 * @param service - Service name for logging
 * @returns The result of the operation
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  context: string,
  service = 'Engine'
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Only retry on transient errors
      if (!isTransientError(error) || attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      logger.debug(
        `${context} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`,
        { error: formatError(error) },
        service
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // TypeScript exhaustiveness safeguard: This throw is unreachable in practice
  // because non-transient or final-attempt errors are thrown inside the loop.
  // Kept as a defensive measure to satisfy the return type and ensure lastError
  // is always thrown if control flow somehow escapes the loop.
  throw lastError;
}
