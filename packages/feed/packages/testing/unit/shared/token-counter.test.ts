/**
 * Tests for Token Counter utilities
 */
import { describe, expect, it } from 'bun:test';
import {
  budgetTokens,
  countTokensSync,
  getModelTokenLimit,
  getSafeContextLimit,
  MODEL_TOKEN_LIMITS,
  truncateToTokenLimitSync,
} from '@feed/api';

describe('Token Counter Utilities', () => {
  describe('countTokensSync', () => {
    it('should estimate tokens based on character count', () => {
      // 4 characters per token approximation
      const result = countTokensSync('Hello world!'); // 12 chars
      expect(result).toBe(3); // ceil(12 / 4)
    });

    it('should handle empty string', () => {
      expect(countTokensSync('')).toBe(0);
    });

    it('should round up to nearest token', () => {
      // 5 chars = ceil(5/4) = 2 tokens
      expect(countTokensSync('Hello')).toBe(2);
    });

    it('should handle long text', () => {
      const longText = 'a'.repeat(400); // 400 chars
      expect(countTokensSync(longText)).toBe(100); // 400/4
    });
  });

  describe('truncateToTokenLimitSync', () => {
    it('should return original text if under limit', () => {
      const text = 'Hello world'; // ~3 tokens
      const result = truncateToTokenLimitSync(text, 10);
      expect(result.text).toBe(text);
    });

    it('should truncate text over limit with ellipsis', () => {
      const text = 'a'.repeat(100); // 25 tokens
      const result = truncateToTokenLimitSync(text, 10);
      expect(result.text.endsWith('...')).toBe(true);
      expect(result.tokens).toBeLessThanOrEqual(10);
    });

    it('should truncate without ellipsis when option is false', () => {
      const text = 'a'.repeat(100); // 25 tokens
      const result = truncateToTokenLimitSync(text, 10, { ellipsis: false });
      expect(result.text.endsWith('...')).toBe(false);
    });

    it('should preserve end when option is true', () => {
      const text = 'START' + 'x'.repeat(100) + 'END';
      const result = truncateToTokenLimitSync(text, 5, {
        preserveEnd: true,
        ellipsis: false,
      });
      expect(result.text.endsWith('END')).toBe(true);
    });

    it('should preserve beginning by default', () => {
      const text = 'START' + 'x'.repeat(100) + 'END';
      const result = truncateToTokenLimitSync(text, 5, { ellipsis: false });
      expect(result.text.startsWith('START')).toBe(true);
    });
  });

  describe('getModelTokenLimit', () => {
    it('should return known model limits', () => {
      expect(getModelTokenLimit('gpt-5.1')).toBe(128000);
      expect(getModelTokenLimit('claude-sonnet-4-5')).toBe(200000);
      expect(getModelTokenLimit('gpt-3.5-turbo')).toBe(16385);
    });

    it('should return default for unknown models', () => {
      expect(getModelTokenLimit('unknown-model')).toBe(8192);
    });

    it('should have entry for Groq models', () => {
      expect(getModelTokenLimit('llama-3.3-70b-versatile')).toBe(131072);
      expect(getModelTokenLimit('openai/gpt-oss-120b')).toBe(131072);
    });
  });

  describe('getSafeContextLimit', () => {
    it('should apply safety margin to model limit', () => {
      // GPT-5.1 has 128000 limit
      // With 2% margin: 128000 * 0.98 = 125440
      const result = getSafeContextLimit('gpt-5.1');
      expect(result).toBe(125440);
    });

    it('should use custom safety margin', () => {
      // GPT-5.1 has 128000 limit
      // With 5% margin: 128000 * 0.95 = 121600
      const result = getSafeContextLimit('gpt-5.1', 8000, 0.05);
      expect(result).toBe(121600);
    });

    it('should enforce minimum of 1000 tokens', () => {
      // Very small model with large margin
      const result = getSafeContextLimit('unknown', 0, 0.99);
      expect(result).toBeGreaterThanOrEqual(1000);
    });

    it('should handle unknown models with default limit', () => {
      // Unknown model defaults to 8192
      // With 2% margin: 8192 * 0.98 = 8028
      const result = getSafeContextLimit('unknown-model');
      expect(result).toBe(8028);
    });
  });

  describe('budgetTokens', () => {
    it('should allocate minimum tokens first', () => {
      const result = budgetTokens(10000, [
        { name: 'system', priority: 1, minTokens: 1000 },
        { name: 'user', priority: 1, minTokens: 500 },
      ]);

      expect(result.system).toBeGreaterThanOrEqual(1000);
      expect(result.user).toBeGreaterThanOrEqual(500);
    });

    it('should distribute remaining tokens by priority', () => {
      const result = budgetTokens(10000, [
        { name: 'low', priority: 1 },
        { name: 'high', priority: 3 },
      ]);

      const high = result['high'] ?? 0;
      const low = result['low'] ?? 0;
      // High priority should get ~3x more than low
      expect(high).toBeGreaterThan(low);
      expect(high).toBeCloseTo(low * 3, -2);
    });

    it('should scale down when minimums exceed total', () => {
      const result = budgetTokens(1000, [
        { name: 'a', priority: 1, minTokens: 800 },
        { name: 'b', priority: 1, minTokens: 800 },
      ]);

      const a = result['a'] ?? 0;
      const b = result['b'] ?? 0;
      // Both should be scaled down
      expect(a + b).toBeLessThanOrEqual(1000);
    });

    it('should handle sections without minimum tokens', () => {
      const result = budgetTokens(10000, [
        { name: 'required', priority: 1, minTokens: 2000 },
        { name: 'optional', priority: 2 },
      ]);

      expect(result['required'] ?? 0).toBeGreaterThanOrEqual(2000);
      expect(result['optional'] ?? 0).toBeGreaterThan(0);
    });

    it('should distribute all available tokens', () => {
      const result = budgetTokens(10000, [
        { name: 'a', priority: 1 },
        { name: 'b', priority: 1 },
        { name: 'c', priority: 1 },
      ]);

      const total =
        (result['a'] ?? 0) + (result['b'] ?? 0) + (result['c'] ?? 0);
      // Should use most of the budget (may lose some to rounding)
      expect(total).toBeGreaterThan(9000);
    });
  });

  describe('MODEL_TOKEN_LIMITS', () => {
    it('should have OpenAI models', () => {
      expect(MODEL_TOKEN_LIMITS['gpt-5.1']).toBeDefined();
      expect(MODEL_TOKEN_LIMITS['gpt-3.5-turbo']).toBeDefined();
    });

    it('should have Anthropic models', () => {
      expect(MODEL_TOKEN_LIMITS['claude-sonnet-4-5']).toBeDefined();
      expect(MODEL_TOKEN_LIMITS['claude-opus-4-1']).toBeDefined();
    });

    it('should have Groq models', () => {
      expect(MODEL_TOKEN_LIMITS['llama-3.3-70b-versatile']).toBeDefined();
      expect(MODEL_TOKEN_LIMITS['mixtral-8x7b-32768']).toBeDefined();
    });
  });
});
