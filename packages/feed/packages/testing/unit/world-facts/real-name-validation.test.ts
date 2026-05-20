/**
 * Real Name Validation Tests
 *
 * Ensures that real names NEVER appear in:
 * - Generated feed content
 * - Organization/actor data files
 * - Database mappings
 * - Prompt examples
 */

import { describe, expect, it } from 'bun:test';
import { getForbiddenRealNames, validateNoRealNames } from '@babylon/engine';

describe('Real Name Validation System', () => {
  describe('Pattern-Based Detection', () => {
    it('should detect "OpenAI" in various forms', () => {
      const testCases = [
        'OpenAI released a new model',
        'openai is leading in AI',
        'Open AI announced today',
        'open-ai partnership',
        'OPENAI stock rises',
      ];

      testCases.forEach((testCase) => {
        const violations = validateNoRealNames(testCase);
        expect(violations.length).toBeGreaterThan(0);
        // Check if any violation contains an OpenAI-related pattern (case-insensitive)
        const hasOpenAIViolation = violations.some((v) =>
          /open[\s-_]?ai/i.test(v)
        );
        expect(hasOpenAIViolation).toBe(true);
      });
    });

    it('should detect "Elon Musk" variations', () => {
      const testCases = [
        'Elon Musk tweeted today',
        'ELON MUSK announces',
        'elon musk says',
      ];

      testCases.forEach((testCase) => {
        const violations = validateNoRealNames(testCase);
        expect(violations.length).toBeGreaterThan(0);
      });
    });

    it('should detect "Sam Altman" variations', () => {
      const testCases = [
        'Sam Altman posted',
        'sam altman announced',
        'SAM ALTMAN says',
      ];

      testCases.forEach((testCase) => {
        const violations = validateNoRealNames(testCase);
        expect(violations.length).toBeGreaterThan(0);
      });
    });

    it('should NOT flag parody names', () => {
      const validCases = [
        'OpenAGI released a new model',
        'AIlon Musk tweeted today',
        'Sam AIltman announced',
        'MetAI partnership',
        'TeslAI stock rises',
      ];

      validCases.forEach((testCase) => {
        const violations = validateNoRealNames(testCase);
        expect(violations.length).toBe(0);
      });
    });

    it('should NOT flag partial word matches', () => {
      const validCases = [
        'metadata field',
        'musket rifle',
        'telescope view',
        'goggles on',
      ];

      validCases.forEach((testCase) => {
        const violations = validateNoRealNames(testCase);
        expect(violations.length).toBe(0);
      });
    });
  });

  describe('Database Forbidden Names List', () => {
    it('should have forbidden names loaded', () => {
      const forbiddenNames = getForbiddenRealNames();
      expect(forbiddenNames).toBeDefined();
      expect(forbiddenNames.length).toBeGreaterThan(0);
    });

    it('should detect names from database list', () => {
      const forbiddenNames = getForbiddenRealNames();

      // Test first few names from the list
      const testNames = forbiddenNames.slice(0, 5);

      testNames.forEach((name) => {
        const violations = validateNoRealNames(
          `Today ${name} announced something`
        );
        expect(violations.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      const violations = validateNoRealNames('');
      expect(violations.length).toBe(0);
    });

    it('should handle text with no names', () => {
      const violations = validateNoRealNames(
        'This is just regular text about AI and technology.'
      );
      expect(violations.length).toBe(0);
    });

    it('should detect names in quotes', () => {
      const violations = validateNoRealNames('"OpenAI" is a company');
      expect(violations.length).toBeGreaterThan(0);
    });

    it('should detect names in parentheses', () => {
      const violations = validateNoRealNames('(OpenAI) announced');
      expect(violations.length).toBeGreaterThan(0);
    });

    it('should detect names with punctuation', () => {
      const violations = validateNoRealNames('OpenAI, Meta, and Google');
      expect(violations.length).toBeGreaterThan(0);
    });
  });

  describe('Mixed Content', () => {
    it('should detect multiple real names in one text', () => {
      const text = 'OpenAI and Meta partnership with Elon Musk';
      const violations = validateNoRealNames(text);

      // Should catch at least OpenAI and Elon Musk patterns
      expect(violations.length).toBeGreaterThan(1);
    });

    it('should allow parody names mixed with regular text', () => {
      const text =
        'OpenAGI and MetAI partnership with AIlon Musk announced today';
      const violations = validateNoRealNames(text);
      expect(violations.length).toBe(0);
    });
  });
});
