import { describe, it, expect, mock } from 'bun:test';
import {
  hasEmbeddingSupport,
  getAvailableAIModels,
} from '../../../src/commands/create/utils/selection';

// Mock clack prompts
mock.module('@clack/prompts', () => ({
  select: mock(),
  cancel: mock(),
  isCancel: mock(),
}));

describe('selection utilities', () => {
  describe('hasEmbeddingSupport', () => {
    it('should return true for models with embedding support', () => {
      expect(hasEmbeddingSupport('local')).toBe(true);
      expect(hasEmbeddingSupport('openai')).toBe(true);
      expect(hasEmbeddingSupport('google')).toBe(true);
    });

    it('should return false for models without embedding support', () => {
      expect(hasEmbeddingSupport('claude')).toBe(false);
      expect(hasEmbeddingSupport('openrouter')).toBe(false);
    });

    it('should return false for unknown models', () => {
      expect(hasEmbeddingSupport('unknown-model')).toBe(false);
      expect(hasEmbeddingSupport('')).toBe(false);
    });

    it('should be case sensitive', () => {
      expect(hasEmbeddingSupport('LOCAL')).toBe(false);
      expect(hasEmbeddingSupport('OpenAI')).toBe(false);
      expect(hasEmbeddingSupport('GOOGLE')).toBe(false);
    });
  });

  describe('getAvailableAIModels', () => {
    it('should return all available AI models', () => {
      const models = getAvailableAIModels();

      expect(models).toBeInstanceOf(Array);
      expect(models.length).toBeGreaterThan(0);

      // Check that it includes known models
      const modelValues = models.map((m) => m.value);
      expect(modelValues).toContain('local');
      expect(modelValues).toContain('claude');
      expect(modelValues).toContain('openai');
      expect(modelValues).toContain('google');
      expect(modelValues).toContain('openrouter');
    });

    it('should have proper structure for each model option', () => {
      const models = getAvailableAIModels();

      models.forEach((model) => {
        expect(model).toHaveProperty('value');
        expect(model).toHaveProperty('title');
        expect(model).toHaveProperty('description');
        expect(typeof model.value).toBe('string');
        expect(typeof model.title).toBe('string');
        expect(typeof model.description).toBe('string');
      });
    });
  });

  describe('AI model selection flow', () => {
    it('should identify which models need separate embedding providers', () => {
      const modelsNeedingEmbeddings = ['claude', 'openrouter'];
      const modelsWithEmbeddings = ['local', 'openai', 'google'];

      modelsNeedingEmbeddings.forEach((model) => {
        expect(hasEmbeddingSupport(model)).toBe(false);
      });

      modelsWithEmbeddings.forEach((model) => {
        expect(hasEmbeddingSupport(model)).toBe(true);
      });
    });
  });
});
