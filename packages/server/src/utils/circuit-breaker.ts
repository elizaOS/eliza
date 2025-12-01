/**
 * Circuit breaker for graceful degradation
 * Uses opossum - battle-tested library from Red Hat/Nodeshift
 * @module middleware/circuit-breaker
 */

import CircuitBreaker from 'opossum';
import { logger } from '@elizaos/core';

// ============================================================================
// Types
// ============================================================================

export interface CircuitBreakerConfig {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

// ============================================================================
// Factory
// ============================================================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  timeout: 10000, // 10s timeout
  errorThresholdPercentage: 50, // Open after 50% errors
  resetTimeout: 30000, // Try again after 30s
  volumeThreshold: 5, // Minimum calls before tripping
};

/**
 * Creates a circuit breaker for an async function
 */
export function createCircuitBreaker<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  name: string,
  config: CircuitBreakerConfig = {}
): CircuitBreaker<T, R> {
  const options = { ...DEFAULT_CONFIG, ...config, name };

  const breaker = new CircuitBreaker(fn, options);

  breaker.on('open', () => {
    logger.warn({ src: 'http', circuit: name }, 'Circuit opened');
  });

  breaker.on('halfOpen', () => {
    logger.info({ src: 'http', circuit: name }, 'Circuit half-open');
  });

  breaker.on('close', () => {
    logger.info({ src: 'http', circuit: name }, 'Circuit closed');
  });

  breaker.on('fallback', () => {
    logger.debug({ src: 'http', circuit: name }, 'Fallback executed');
  });

  return breaker;
}

/**
 * Pre-configured circuit breaker for database operations
 */
export const dbCircuitBreaker = createCircuitBreaker(
  async <T>(operation: () => Promise<T>): Promise<T> => operation(),
  'database',
  {
    timeout: 30000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
  }
);

export { CircuitBreaker };