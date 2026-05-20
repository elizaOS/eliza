/**
 * Array Utilities Unit Tests
 *
 * Tests for safe array access utilities.
 */

import { describe, expect, test } from 'bun:test';
import {
  assertNonEmpty,
  at,
  atOrThrow,
  first,
  firstOrThrow,
  isNonEmpty,
  last,
  lastOrThrow,
} from '../../utils/array-utils';

describe('Array Utilities', () => {
  describe('first', () => {
    test('returns first element of non-empty array', () => {
      expect(first([1, 2, 3])).toBe(1);
    });

    test('returns undefined for empty array', () => {
      expect(first([])).toBeUndefined();
    });

    test('works with string arrays', () => {
      expect(first(['a', 'b', 'c'])).toBe('a');
    });

    test('works with object arrays', () => {
      const obj = { id: 1 };
      expect(first([obj, { id: 2 }])).toBe(obj);
    });

    test('returns falsy first element', () => {
      expect(first([0, 1, 2])).toBe(0);
      expect(first([null, 1, 2])).toBeNull();
      expect(first(['', 'a'])).toBe('');
    });
  });

  describe('firstOrThrow', () => {
    test('returns first element of non-empty array', () => {
      expect(firstOrThrow([1, 2, 3])).toBe(1);
    });

    test('throws for empty array with default message', () => {
      expect(() => firstOrThrow([])).toThrow('Expected non-empty array');
    });

    test('throws for empty array with custom message', () => {
      expect(() => firstOrThrow([], 'No users found')).toThrow(
        'No users found'
      );
    });

    test('returns falsy first elements without throwing', () => {
      expect(firstOrThrow([0, 1, 2])).toBe(0);
      expect(firstOrThrow([null, 1, 2])).toBeNull();
    });
  });

  describe('last', () => {
    test('returns last element of non-empty array', () => {
      expect(last([1, 2, 3])).toBe(3);
    });

    test('returns undefined for empty array', () => {
      expect(last([])).toBeUndefined();
    });

    test('returns same element for single-element array', () => {
      expect(last([42])).toBe(42);
    });

    test('returns falsy elements correctly', () => {
      expect(last([0])).toBe(0);
      expect(last([null])).toBeNull();
      expect(last([''])).toBe('');
    });
  });

  describe('lastOrThrow', () => {
    test('returns last element of non-empty array', () => {
      expect(lastOrThrow([1, 2, 3])).toBe(3);
    });

    test('throws for empty array with default message', () => {
      expect(() => lastOrThrow([])).toThrow('Expected non-empty array');
    });

    test('throws for empty array with custom message', () => {
      expect(() => lastOrThrow([], 'No items')).toThrow('No items');
    });

    test('returns falsy last element', () => {
      expect(lastOrThrow([0, null, false])).toBe(false);
      expect(lastOrThrow(['x', 0])).toBe(0);
      expect(lastOrThrow([true, ''])).toBe('');
    });
  });

  describe('assertNonEmpty', () => {
    test('does not throw for non-empty array', () => {
      const arr = [1, 2, 3];
      expect(() => assertNonEmpty(arr)).not.toThrow();
    });

    test('throws for empty array', () => {
      expect(() => assertNonEmpty([])).toThrow('Empty array');
    });

    test('includes context in error message', () => {
      expect(() => assertNonEmpty([], 'users list')).toThrow(
        'Empty array: users list'
      );
    });
  });

  describe('isNonEmpty', () => {
    test('returns true for non-empty array', () => {
      expect(isNonEmpty([1, 2, 3])).toBe(true);
    });

    test('returns false for empty array', () => {
      expect(isNonEmpty([])).toBe(false);
    });

    test('returns true for array with single element', () => {
      expect(isNonEmpty([42])).toBe(true);
    });
  });

  describe('at', () => {
    test('returns element at positive index', () => {
      expect(at([1, 2, 3], 0)).toBe(1);
      expect(at([1, 2, 3], 1)).toBe(2);
      expect(at([1, 2, 3], 2)).toBe(3);
    });

    test('returns element at negative index', () => {
      expect(at([1, 2, 3], -1)).toBe(3);
      expect(at([1, 2, 3], -2)).toBe(2);
      expect(at([1, 2, 3], -3)).toBe(1);
    });

    test('returns undefined for out of bounds positive index', () => {
      expect(at([1, 2, 3], 10)).toBeUndefined();
    });

    test('returns undefined for out of bounds negative index', () => {
      expect(at([1, 2, 3], -10)).toBeUndefined();
    });

    test('returns undefined for empty array', () => {
      expect(at([], 0)).toBeUndefined();
    });
  });

  describe('atOrThrow', () => {
    test('returns element at valid index', () => {
      expect(atOrThrow([1, 2, 3], 1)).toBe(2);
    });

    test('handles negative indices', () => {
      expect(atOrThrow([1, 2, 3], -1)).toBe(3);
    });

    test('throws for out of bounds index with default message', () => {
      expect(() => atOrThrow([1, 2, 3], 10)).toThrow(
        'Index 10 out of bounds for array of length 3'
      );
    });

    test('throws for out of bounds negative index', () => {
      expect(() => atOrThrow([1, 2, 3], -10)).toThrow(
        'Index -10 out of bounds for array of length 3'
      );
    });

    test('throws with custom message', () => {
      expect(() => atOrThrow([1, 2, 3], 10, 'Invalid index')).toThrow(
        'Invalid index'
      );
    });

    test('throws for empty array', () => {
      expect(() => atOrThrow([], 0)).toThrow(
        'Index 0 out of bounds for array of length 0'
      );
    });
  });
});
