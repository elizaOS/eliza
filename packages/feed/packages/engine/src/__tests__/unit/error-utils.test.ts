/**
 * Error Utilities Unit Tests
 *
 * Tests for error handling utilities in the engine package.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  formatError,
  formatErrorWithStack,
  handleNonCritical,
  handleNonCriticalWithDefault,
  hasErrorCode,
  isTransientError,
  safeExecute,
  withRetry,
} from '../../utils/error-utils';

// Mock the logger to prevent actual logging during tests
mock.module('@babylon/shared', () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

describe('Error Utilities', () => {
  describe('formatError', () => {
    test('extracts message from Error object', () => {
      expect(formatError(new Error('test error'))).toBe('test error');
    });

    test('returns string as-is', () => {
      expect(formatError('string error')).toBe('string error');
    });

    test('extracts message from object with message property', () => {
      expect(formatError({ message: 'object error' })).toBe('object error');
    });

    test('converts non-error values to string', () => {
      expect(formatError(123)).toBe('123');
      expect(formatError(null)).toBe('null');
      expect(formatError(undefined)).toBe('undefined');
    });
  });

  describe('formatErrorWithStack', () => {
    test('extracts message and stack from Error object', () => {
      const error = new Error('test error');
      const result = formatErrorWithStack(error);
      expect(result.message).toBe('test error');
      expect(result.stack).toBeDefined();
    });

    test('returns only message for non-Error values', () => {
      const result = formatErrorWithStack('string error');
      expect(result.message).toBe('string error');
      expect(result.stack).toBeUndefined();
    });
  });

  describe('hasErrorCode', () => {
    test('returns true when error has matching code', () => {
      const error = { code: 'ENOENT', message: 'Not found' };
      expect(hasErrorCode(error, 'ENOENT')).toBe(true);
    });

    test('returns false when error has different code', () => {
      const error = { code: 'EPERM', message: 'Permission denied' };
      expect(hasErrorCode(error, 'ENOENT')).toBe(false);
    });

    test('returns false for error without code', () => {
      expect(hasErrorCode(new Error('test'), 'ENOENT')).toBe(false);
    });

    test('returns false for non-object error', () => {
      expect(hasErrorCode('string error', 'ENOENT')).toBe(false);
      expect(hasErrorCode(null, 'ENOENT')).toBe(false);
    });
  });

  describe('isTransientError', () => {
    test('returns true for timeout errors', () => {
      expect(isTransientError(new Error('Connection timed out'))).toBe(true);
      expect(isTransientError(new Error('Request timeout'))).toBe(true);
    });

    test('returns true for connection errors', () => {
      expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
      expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    });

    test('returns true for rate limit errors', () => {
      expect(isTransientError(new Error('Rate limit exceeded'))).toBe(true);
      expect(isTransientError(new Error('Too many requests'))).toBe(true);
      expect(isTransientError(new Error('Error 429'))).toBe(true);
    });

    test('returns true for service unavailable', () => {
      expect(isTransientError(new Error('Service unavailable'))).toBe(true);
      expect(isTransientError(new Error('Error 503'))).toBe(true);
    });

    test('returns false for non-transient errors', () => {
      expect(isTransientError(new Error('Invalid argument'))).toBe(false);
      expect(isTransientError(new Error('Not found'))).toBe(false);
    });

    test('is case insensitive', () => {
      expect(isTransientError(new Error('TIMEOUT'))).toBe(true);
      expect(isTransientError(new Error('Network Error'))).toBe(true);
    });
  });

  describe('safeExecute', () => {
    test('returns result on success', async () => {
      const result = await safeExecute(
        () => Promise.resolve('success'),
        'test operation'
      );
      expect(result).toBe('success');
    });

    test('returns null on error', async () => {
      const result = await safeExecute(
        () => Promise.reject(new Error('failure')),
        'test operation'
      );
      expect(result).toBeNull();
    });
  });

  describe('handleNonCritical', () => {
    test('returns result on success', async () => {
      const result = await handleNonCritical(
        () => Promise.resolve({ value: 42 }),
        'test operation'
      );
      expect(result).toEqual({ value: 42 });
    });

    test('returns null on error', async () => {
      const result = await handleNonCritical(
        () => Promise.reject(new Error('failure')),
        'test operation'
      );
      expect(result).toBeNull();
    });
  });

  describe('handleNonCriticalWithDefault', () => {
    test('returns result on success', async () => {
      const result = await handleNonCriticalWithDefault(
        () => Promise.resolve(42),
        0,
        'test operation'
      );
      expect(result).toBe(42);
    });

    test('returns default value on error', async () => {
      const result = await handleNonCriticalWithDefault(
        () => Promise.reject(new Error('failure')),
        -1,
        'test operation'
      );
      expect(result).toBe(-1);
    });
  });

  describe('withRetry', () => {
    test('returns result on first success', async () => {
      let attempts = 0;
      const result = await withRetry(
        async () => {
          attempts++;
          return 'success';
        },
        3,
        'test operation'
      );
      expect(result).toBe('success');
      expect(attempts).toBe(1);
    });

    test('throws non-transient errors immediately', async () => {
      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            throw new Error('Invalid argument');
          },
          3,
          'test operation'
        )
      ).rejects.toThrow('Invalid argument');
      expect(attempts).toBe(1);
    });

    test('retries transient errors', async () => {
      let attempts = 0;
      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Connection timeout');
          }
          return 'success';
        },
        5,
        'test operation'
      );
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    test('throws after max retries exhausted', async () => {
      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            throw new Error('Connection timeout');
          },
          3,
          'test operation'
        )
      ).rejects.toThrow('Connection timeout');
      expect(attempts).toBe(3);
    });
  });
});
