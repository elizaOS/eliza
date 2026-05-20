/**
 * JSON Parser Unit Tests
 * Tests for safe JSON parsing utilities
 */

import { describe, expect, it } from 'bun:test';
import { parseJsonString, parseJsonWithFallback } from '@babylon/shared';

describe('JSON Parser', () => {
  describe('parseJsonString', () => {
    it('should parse valid JSON', () => {
      const result = parseJsonString('{"key": "value"}');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('should parse arrays', () => {
      const result = parseJsonString('[1, 2, 3]');
      expect(result.success).toBe(true);
      expect(result.data).toEqual([1, 2, 3]);
    });

    it('should parse nested objects', () => {
      const result = parseJsonString('{"nested": {"key": "value"}}');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ nested: { key: 'value' } });
    });

    it('should handle null input', () => {
      const result = parseJsonString(null);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty or null input');
    });

    it('should handle undefined input', () => {
      const result = parseJsonString(undefined);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty or null input');
    });

    it('should handle empty string', () => {
      const result = parseJsonString('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty or null input');
    });

    it('should handle invalid JSON', () => {
      const result = parseJsonString('not valid json');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle malformed JSON', () => {
      const result = parseJsonString('{"key": value}');
      expect(result.success).toBe(false);
    });

    it('should type the result correctly', () => {
      interface TestType {
        name: string;
        age: number;
      }
      const result = parseJsonString<TestType>('{"name": "John", "age": 30}');
      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.name).toBe('John');
        expect(result.data.age).toBe(30);
      }
    });
  });

  describe('parseJsonWithFallback', () => {
    it('should return parsed data for valid JSON', () => {
      const result = parseJsonWithFallback<Record<string, string>>(
        '{"key": "value"}',
        { default: 'fallback' }
      );
      expect(result).toEqual({ key: 'value' });
    });

    it('should return fallback for null input', () => {
      const fallback = { default: 'fallback' };
      const result = parseJsonWithFallback(null, fallback);
      expect(result).toEqual(fallback);
    });

    it('should return fallback for invalid JSON', () => {
      const fallback = { default: 'fallback' };
      const result = parseJsonWithFallback('invalid json', fallback);
      expect(result).toEqual(fallback);
    });

    it('should return fallback for empty string', () => {
      const fallback = [1, 2, 3];
      const result = parseJsonWithFallback('', fallback);
      expect(result).toEqual(fallback);
    });

    it('should work with different fallback types', () => {
      expect(parseJsonWithFallback(null, 'default')).toBe('default');
      expect(parseJsonWithFallback(null, 123)).toBe(123);
      expect(parseJsonWithFallback(null, [])).toEqual([]);
    });
  });
});
