import { logger } from '../index';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenAttempts?: number;
}

export class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: CircuitState = 'closed';
  private halfOpenAttempts: number = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly maxHalfOpenAttempts: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 60000;
    this.maxHalfOpenAttempts = options.halfOpenAttempts ?? 3;
  }

  getState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.lastFailureTime > this.resetTimeout) {
      this.state = 'half-open';
      this.halfOpenAttempts = 0;
      logger.info({ src: 'circuit-breaker' }, 'Circuit breaker entering half-open state');
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'open') {
      logger.warn({ src: 'circuit-breaker' }, 'Circuit breaker is open, using fallback');
      if (fallback) {
        return await fallback();
      }
      throw new Error('Circuit breaker is open');
    }

    if (currentState === 'half-open') {
      if (this.halfOpenAttempts >= this.maxHalfOpenAttempts) {
        this.state = 'open';
        this.lastFailureTime = Date.now();
        logger.warn(
          { src: 'circuit-breaker' },
          'Circuit breaker reopened after failed half-open attempts'
        );
        if (fallback) {
          return await fallback();
        }
        throw new Error('Circuit breaker is open');
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordSuccess(): void {
    if (this.state === 'half-open') {
      logger.info(
        { src: 'circuit-breaker' },
        'Circuit breaker closing after successful half-open attempt'
      );
      this.state = 'closed';
      this.halfOpenAttempts = 0;
    }
    this.failures = 0;
  }

  private recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      logger.warn(
        { src: 'circuit-breaker', failures: this.failures },
        'Circuit breaker opened due to failure threshold'
      );
    }
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
    this.halfOpenAttempts = 0;
    this.lastFailureTime = 0;
  }

  getMetrics(): {
    state: CircuitState;
    failures: number;
    lastFailureTime: number;
    halfOpenAttempts: number;
  } {
    return {
      state: this.getState(),
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      halfOpenAttempts: this.halfOpenAttempts,
    };
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    circuitBreaker?: CircuitBreaker;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseBackoffMs = 500,
    maxBackoffMs = 5000,
    circuitBreaker,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const backoffMs = Math.min(baseBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      if (circuitBreaker) {
        return await circuitBreaker.execute(fn);
      }

      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries - 1) {
        onRetry?.(lastError, attempt + 1);
        logger.debug(
          {
            src: 'retry',
            attempt: attempt + 1,
            maxRetries,
            error: lastError.message,
          },
          'Retrying after error'
        );
      }
    }
  }

  throw lastError || new Error('Max retries exceeded');
}
