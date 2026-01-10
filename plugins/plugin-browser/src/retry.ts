/**
 * Retry utility for handling flaky browser operations
 */

import { logger } from '@elizaos/core';

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export const browserRetryConfigs = {
  navigation: {
    maxAttempts: 3,
    maxRetries: 3, // Alias for compatibility
    initialDelay: 1000,
    maxDelay: 5000,
    backoffMultiplier: 2,
  },
  action: {
    maxAttempts: 2,
    maxRetries: 2, // Alias for compatibility
    initialDelay: 500,
    maxDelay: 2000,
    backoffMultiplier: 1.5,
  },
  extraction: {
    maxAttempts: 2,
    maxRetries: 2, // Alias for compatibility
    initialDelay: 500,
    maxDelay: 3000,
    backoffMultiplier: 2,
  },
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> & { maxRetries?: number; timeout?: number },
  operation: string
): Promise<T> {
  // Support both maxRetries and maxAttempts
  const maxAttempts = config.maxAttempts || config.maxRetries || 3;
  const initialDelay = config.initialDelay || 1000;
  const maxDelay = config.maxDelay || 5000;
  const backoffMultiplier = config.backoffMultiplier || 2;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`Attempting ${operation} (attempt ${attempt}/${maxAttempts})`);

      if (config.timeout) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${operation} timed out after ${config.timeout}ms`)),
            config.timeout
          )
        );
        return await Promise.race([fn(), timeoutPromise]);
      }

      return await fn();
    } catch (error) {
      lastError = error as Error;
      logger.warn(`${operation} failed (attempt ${attempt}/${maxAttempts}):`, error);

      if (attempt < maxAttempts) {
        logger.info(`Retrying ${operation} in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      }
    }
  }

  logger.error(`${operation} failed after ${maxAttempts} attempts`);
  throw lastError || new Error(`${operation} failed after ${maxAttempts} attempts`);
}
