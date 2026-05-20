/**
 * Validation Unit Tests
 * Tests for content validation utilities
 */

import { describe, expect, it } from 'bun:test';
import { ContentValidator } from '@babylon/shared';

describe('Content Validator', () => {
  describe('validatePostContent', () => {
    it('should accept valid post content', () => {
      expect(() =>
        ContentValidator.validatePostContent('Valid post content')
      ).not.toThrow();
    });

    it('should reject null content', () => {
      expect(() => ContentValidator.validatePostContent(null)).toThrow(
        'content is null or undefined'
      );
    });

    it('should reject undefined content', () => {
      expect(() => ContentValidator.validatePostContent(undefined)).toThrow(
        'content is null or undefined'
      );
    });

    it('should reject empty content', () => {
      expect(() => ContentValidator.validatePostContent('')).toThrow(
        'content cannot be empty'
      );
      expect(() => ContentValidator.validatePostContent('   ')).toThrow(
        'content cannot be empty'
      );
    });

    it('should reject non-string content', () => {
      expect(() => ContentValidator.validatePostContent(123)).toThrow(
        'content must be string'
      );
      expect(() =>
        ContentValidator.validatePostContent({ text: 'hello' })
      ).toThrow('content must be string');
    });

    it('should reject content exceeding max length', () => {
      const longContent = 'a'.repeat(5001);
      expect(() => ContentValidator.validatePostContent(longContent)).toThrow(
        'exceeds maximum length'
      );
    });

    it('should include context in error message', () => {
      expect(() =>
        ContentValidator.validatePostContent(null, 'media post')
      ).toThrow('media post');
    });
  });

  describe('validateEventDescription', () => {
    it('should accept valid descriptions', () => {
      expect(() =>
        ContentValidator.validateEventDescription('Valid event description')
      ).not.toThrow();
    });

    it('should reject null/undefined', () => {
      expect(() => ContentValidator.validateEventDescription(null)).toThrow();
      expect(() =>
        ContentValidator.validateEventDescription(undefined)
      ).toThrow();
    });

    it('should reject empty descriptions', () => {
      expect(() => ContentValidator.validateEventDescription('')).toThrow(
        'cannot be empty'
      );
    });

    it('should warn but not throw for long descriptions', () => {
      const longDesc = 'a'.repeat(300);
      // Should not throw - just warns
      expect(() =>
        ContentValidator.validateEventDescription(longDesc)
      ).not.toThrow();
    });
  });

  describe('validateQuestionText', () => {
    it('should accept valid question text', () => {
      expect(() =>
        ContentValidator.validateQuestionText('Will this happen?')
      ).not.toThrow();
    });

    it('should reject empty questions', () => {
      expect(() => ContentValidator.validateQuestionText('')).toThrow();
    });

    it('should reject questions exceeding max length', () => {
      const longQuestion = 'a'.repeat(501);
      expect(() => ContentValidator.validateQuestionText(longQuestion)).toThrow(
        'exceeds maximum length'
      );
    });
  });

  describe('validateEntityName', () => {
    it('should accept valid entity names', () => {
      expect(() =>
        ContentValidator.validateEntityName('John Doe')
      ).not.toThrow();
    });

    it('should reject empty names', () => {
      expect(() => ContentValidator.validateEntityName('')).toThrow(
        'cannot be empty'
      );
      expect(() => ContentValidator.validateEntityName('   ')).toThrow(
        'cannot be empty'
      );
    });

    it('should reject non-string names', () => {
      expect(() => ContentValidator.validateEntityName(123)).toThrow(
        'must be string'
      );
    });
  });

  describe('validateDayNumber', () => {
    it('should accept valid day numbers', () => {
      expect(() => ContentValidator.validateDayNumber(1)).not.toThrow();
      expect(() => ContentValidator.validateDayNumber(15)).not.toThrow();
      expect(() => ContentValidator.validateDayNumber(30)).not.toThrow();
    });

    it('should reject non-numbers', () => {
      expect(() => ContentValidator.validateDayNumber('5')).toThrow(
        'must be number'
      );
    });

    it('should reject out-of-range days', () => {
      expect(() => ContentValidator.validateDayNumber(0)).toThrow(
        'must be between 1 and 30'
      );
      expect(() => ContentValidator.validateDayNumber(31)).toThrow(
        'must be between 1 and 30'
      );
      expect(() => ContentValidator.validateDayNumber(-1)).toThrow(
        'must be between 1 and 30'
      );
    });

    it('should reject non-finite numbers', () => {
      expect(() => ContentValidator.validateDayNumber(Infinity)).toThrow(
        'must be finite'
      );
      expect(() => ContentValidator.validateDayNumber(NaN)).toThrow(
        'must be finite'
      );
    });
  });

  describe('validateTimestamp', () => {
    it('should accept Date objects', () => {
      expect(() =>
        ContentValidator.validateTimestamp(new Date())
      ).not.toThrow();
    });

    it('should accept ISO strings', () => {
      expect(() =>
        ContentValidator.validateTimestamp('2025-01-15T10:00:00Z')
      ).not.toThrow();
    });

    it('should reject null/undefined', () => {
      expect(() => ContentValidator.validateTimestamp(null)).toThrow(
        'required'
      );
      expect(() => ContentValidator.validateTimestamp(undefined)).toThrow(
        'required'
      );
    });

    it('should reject invalid dates', () => {
      expect(() => ContentValidator.validateTimestamp('not a date')).toThrow(
        'invalid date'
      );
    });

    it('should reject non-date types', () => {
      expect(() => ContentValidator.validateTimestamp(123)).toThrow(
        'must be Date or ISO string'
      );
    });
  });

  describe('validateNotEmpty', () => {
    it('should accept non-empty arrays', () => {
      expect(() =>
        ContentValidator.validateNotEmpty([1, 2, 3], 'items')
      ).not.toThrow();
    });

    it('should reject empty arrays', () => {
      expect(() => ContentValidator.validateNotEmpty([], 'items')).toThrow(
        'cannot be empty'
      );
    });

    it('should reject non-arrays', () => {
      expect(() =>
        ContentValidator.validateNotEmpty(
          'not an array' as unknown as [],
          'items'
        )
      ).toThrow('must be an array');
    });
  });

  describe('truncateContent', () => {
    it('should return content unchanged if within limit', () => {
      const content = 'Short content';
      const result = ContentValidator.truncateContent(content, 100);
      expect(result).toBe(content);
    });

    it('should truncate content exceeding limit', () => {
      const content =
        'This is a long piece of content that should be truncated';
      const result = ContentValidator.truncateContent(content, 20);
      expect(result.length).toBe(20);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('sanitizeContent', () => {
    it('should trim whitespace', () => {
      expect(ContentValidator.sanitizeContent('  hello  ')).toBe('hello');
    });

    it('should remove null bytes', () => {
      expect(ContentValidator.sanitizeContent('hello\u0000world')).toBe(
        'helloworld'
      );
    });

    it('should remove control characters', () => {
      expect(ContentValidator.sanitizeContent('hello\u0001\u0002world')).toBe(
        'helloworld'
      );
    });

    it('should preserve normal content', () => {
      const content = 'Hello, world! 123';
      expect(ContentValidator.sanitizeContent(content)).toBe(content);
    });
  });
});
