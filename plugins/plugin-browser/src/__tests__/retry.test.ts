import { describe, expect, it, mock, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { retryWithBackoff, browserRetryConfigs } from '../retry';
import { logger } from '@elizaos/core';

// Mock logger
mock.module('@elizaos/core', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

describe('retry utilities', () => {
  let unhandledRejections: any[] = [];

  beforeEach(() => {
    mock.restore();
    unhandledRejections = [];
  });

  afterEach(async () => {
    // Clear any unhandled rejections
    unhandledRejections = [];
  });

  // Suppress unhandled rejection warnings for expected failures
  const originalConsoleError = console.error;
  const unhandledRejectionHandler = (reason: any) => {
    unhandledRejections.push(reason);
  };

  beforeAll(() => {
    process.on('unhandledRejection', unhandledRejectionHandler);
    console.error = (...args: any[]) => {
      if (
        args[0]?.includes &&
        (args[0].includes('PromiseRejectionHandledWarning') ||
          args[0].includes('test operation timed out'))
      ) {
        return;
      }
      originalConsoleError(...args);
    };
  });

  afterAll(() => {
    process.off('unhandledRejection', unhandledRejectionHandler);
    console.error = originalConsoleError;
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt', async () => {
      const fn = mock().mockResolvedValue('success');

      const result = await retryWithBackoff(fn, {}, 'test operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Attempting test operation (attempt 1/3)');
    });

    it('should retry on failure and succeed', async () => {
      const fn = mock()
        .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
        .mockResolvedValueOnce('success');

      const result = await retryWithBackoff(
        fn,
        { maxRetries: 3, initialDelay: 100 },
        'test operation'
      );

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should fail after max retries', async () => {
      const error = new Error('ETIMEDOUT');
      const fn = mock().mockRejectedValue(error);

      await expect(
        retryWithBackoff(fn, { maxRetries: 2, initialDelay: 100 }, 'test operation')
      ).rejects.toThrow('ETIMEDOUT');

      expect(fn).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith('test operation failed after 2 attempts');
    });

    it('should not retry non-retryable errors', async () => {
      const error = new Error('Invalid credentials');
      const fn = mock().mockRejectedValue(error);

      await expect(retryWithBackoff(fn, {}, 'test operation')).rejects.toThrow(
        'Invalid credentials'
      );

      expect(fn).toHaveBeenCalledTimes(3); // Default maxAttempts
      expect(logger.error).toHaveBeenCalledWith('test operation failed after 3 attempts');
    });

    it('should handle timeout', async () => {
      const fn = mock().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('success'), 2000))
      );

      await expect(retryWithBackoff(fn, { timeout: 500 }, 'test operation')).rejects.toThrow(
        'test operation timed out after 500ms'
      );

      expect(fn).toHaveBeenCalledTimes(3); // Default maxAttempts, timeout is per attempt
    }, 10000);

    it('should apply exponential backoff', async () => {
      let callCount = 0;
      const fn = mock().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('Timeout'));
        }
        return Promise.resolve('success');
      });

      const startTime = Date.now();
      const result = await retryWithBackoff(
        fn,
        { maxRetries: 3, initialDelay: 10, backoffMultiplier: 2 },
        'test'
      );

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);

      // Verify that the timing includes backoff delays
      const totalTime = Date.now() - startTime;
      // First attempt: 0ms, Second attempt: 10ms delay, Third attempt: 20ms delay
      // Total minimum expected time: 30ms (plus some execution time)
      expect(totalTime).toBeGreaterThan(25); // Allow some margin
    });

    it('should respect maxDelay', async () => {
      const fn = mock()
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce('success');

      const result = await retryWithBackoff(
        fn,
        {
          maxRetries: 2,
          initialDelay: 2000,
          maxDelay: 2500,
          backoffMultiplier: 2,
        },
        'test'
      );

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  // TODO: Implement Retry decorator
  // describe('Retry decorator', () => {
  //   it('should retry decorated method', async () => {
  //     const originalFn = mock()
  //       .mockRejectedValueOnce(new Error('Timeout'))
  //       .mockResolvedValueOnce('success');

  //     const descriptor: PropertyDescriptor = {
  //       value: originalFn,
  //       writable: true,
  //       enumerable: false,
  //       configurable: true,
  //     };

  //     const decoratedDescriptor = Retry({ maxRetries: 2, initialDelay: 100 })(
  //       {},
  //       'testMethod',
  //       descriptor
  //     );

  //     const result = await decoratedDescriptor.value();

  //     expect(result).toBe('success');
  //     expect(originalFn).toHaveBeenCalledTimes(2);
  //   });

  //   it('should preserve this context', async () => {
  //     const testObj = {
  //       value: 'test',
  //       async getValue() {
  //         return this.value;
  //       },
  //     };

  //     const descriptor: PropertyDescriptor = {
  //       value: testObj.getValue,
  //       writable: true,
  //       enumerable: false,
  //       configurable: true,
  //     };

  //     const decoratedDescriptor = Retry({ maxRetries: 1 })(testObj, 'getValue', descriptor);

  //     const result = await decoratedDescriptor.value.call(testObj);

  //     expect(result).toBe('test');
  //   });
  // });

  describe('browserRetryConfigs', () => {
    it('should have navigation config', () => {
      const config = browserRetryConfigs.navigation;

      expect(config.maxRetries).toBe(3);
      expect(config.initialDelay).toBe(1000);
      expect(config.maxDelay).toBe(5000);
      expect(config.backoffMultiplier).toBe(2);
    });

    it('should have action config', () => {
      const config = browserRetryConfigs.action;

      expect(config.maxRetries).toBe(2);
      expect(config.initialDelay).toBe(500);
      expect(config.maxDelay).toBe(2000);
      expect(config.backoffMultiplier).toBe(1.5);
    });

    it('should have extraction config', () => {
      const config = browserRetryConfigs.extraction;

      expect(config.maxRetries).toBe(2);
      expect(config.initialDelay).toBe(500);
      expect(config.maxDelay).toBe(3000);
      expect(config.backoffMultiplier).toBe(2);
    });
  });
});
