/**
 * Common utility functions
 */

import * as crypto from 'crypto';

/**
 * Format duration in seconds to human readable format
 */
export function formatDuration(seconds: number): string {
  if (seconds === 0) {
    return '0s';
  }

  const isNegative = seconds < 0;
  const absSeconds = Math.abs(seconds);

  const days = Math.floor(absSeconds / 86400);
  const hours = Math.floor((absSeconds % 86400) / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const secs = absSeconds % 60;

  let result = '';

  if (days > 0) {
    result = `${days}d ${hours}h ${minutes}m ${secs}s`;
  } else if (hours > 0) {
    result = `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    result = `${minutes}m ${secs}s`;
  } else {
    result = `${secs}s`;
  }

  return isNegative ? `-${result}` : result;
}

/**
 * Truncate string to specified length
 */
export function truncateString(str: string, maxLength: number): string {
  if (!str || str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Calculate hash of data
 */
export function calculateHash(data: unknown): string {
  const stringData = typeof data === 'object' ? JSON.stringify(data, Object.keys(data as object).sort()) : String(data);

  return crypto.createHash('sha256').update(stringData).digest('hex');
}

/**
 * Retry options interface
 */
interface RetryOptions {
  retries?: number;
  delay?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Retry an async operation
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, delay = 1000, onRetry } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < retries) {
        if (onRetry) {
          onRetry(lastError, attempt + 1);
        }

        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  throw lastError!;
}

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return function debounced(...args: Parameters<T>) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let lastCallTime = 0;
  let timeoutId: NodeJS.Timeout | null = null;

  return function throttled(...args: Parameters<T>) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;

    if (timeSinceLastCall >= delay) {
      fn(...args);
      lastCallTime = now;
    } else {
      // Schedule the call for later if we're still within the throttle period
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const remainingTime = delay - timeSinceLastCall;
      timeoutId = setTimeout(() => {
        fn(...args);
        lastCallTime = Date.now();
        timeoutId = null;
      }, remainingTime);
    }
  };
}
