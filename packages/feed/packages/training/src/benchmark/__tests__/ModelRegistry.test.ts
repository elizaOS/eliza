/**
 * Tests for ModelRegistry
 *
 * Comprehensive tests covering:
 * - Existing registry functions
 * - New local model creation functions
 * - Environment variable parsing
 * - Edge cases and validation
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  createLocalModel,
  createLocalModelFromEnv,
  getBaselineModels,
  getModelById,
  getModelByModelId,
  getModelDisplayName,
  getModelsByProvider,
  getModelsByTier,
  MODEL_REGISTRY,
  validateModelId,
} from '../ModelRegistry';

// =============================================================================
// Registry Content Tests
// =============================================================================

describe('MODEL_REGISTRY', () => {
  test('contains at least one model', () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
  });

  test('all models have required fields', () => {
    for (const model of MODEL_REGISTRY) {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);

      expect(model.displayName).toBeDefined();
      expect(typeof model.displayName).toBe('string');

      expect(model.provider).toBeDefined();
      expect(['groq', 'openai', 'anthropic', 'together', 'local']).toContain(
        model.provider
      );

      expect(model.modelId).toBeDefined();
      expect(typeof model.modelId).toBe('string');

      expect(model.tier).toBeDefined();
      expect(['lite', 'standard', 'pro']).toContain(model.tier);

      expect(typeof model.isBaseline).toBe('boolean');
    }
  });

  test('model IDs are unique', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// =============================================================================
// getModelById Tests
// =============================================================================

describe('getModelById', () => {
  test('returns model for valid ID', () => {
    const model = getModelById('llama-8b');
    expect(model).toBeDefined();
    expect(model?.id).toBe('llama-8b');
  });

  test('returns undefined for invalid ID', () => {
    const model = getModelById('nonexistent-model');
    expect(model).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    const model = getModelById('');
    expect(model).toBeUndefined();
  });
});

// =============================================================================
// getModelByModelId Tests
// =============================================================================

describe('getModelByModelId', () => {
  test('returns model for valid modelId', () => {
    const model = getModelByModelId('llama-3.1-8b-instant');
    expect(model).toBeDefined();
    expect(model?.modelId).toBe('llama-3.1-8b-instant');
  });

  test('returns undefined for invalid modelId', () => {
    const model = getModelByModelId('nonexistent-model-id');
    expect(model).toBeUndefined();
  });
});

// =============================================================================
// getBaselineModels Tests
// =============================================================================

describe('getBaselineModels', () => {
  test('returns only baseline models', () => {
    const baselines = getBaselineModels();
    expect(baselines.length).toBeGreaterThan(0);
    expect(baselines.every((m) => m.isBaseline)).toBe(true);
  });

  test('all baseline models are in registry', () => {
    const baselines = getBaselineModels();
    for (const model of baselines) {
      const found = getModelById(model.id);
      expect(found).toBeDefined();
    }
  });
});

// =============================================================================
// getModelsByProvider Tests
// =============================================================================

describe('getModelsByProvider', () => {
  test('returns groq models', () => {
    const models = getModelsByProvider('groq');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'groq')).toBe(true);
  });

  test('returns openai models', () => {
    const models = getModelsByProvider('openai');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'openai')).toBe(true);
  });

  test('returns anthropic models', () => {
    const models = getModelsByProvider('anthropic');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  test('returns empty array for local provider (none in registry)', () => {
    // Note: Local models are created dynamically, not in registry
    const models = getModelsByProvider('local');
    expect(models).toEqual([]);
  });
});

// =============================================================================
// getModelsByTier Tests
// =============================================================================

describe('getModelsByTier', () => {
  test('returns lite tier models', () => {
    const models = getModelsByTier('lite');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.tier === 'lite')).toBe(true);
  });

  test('returns standard tier models', () => {
    const models = getModelsByTier('standard');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.tier === 'standard')).toBe(true);
  });

  test('returns pro tier models', () => {
    const models = getModelsByTier('pro');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.tier === 'pro')).toBe(true);
  });
});

// =============================================================================
// validateModelId Tests
// =============================================================================

describe('validateModelId', () => {
  test('returns true for valid model ID', () => {
    expect(validateModelId('llama-8b')).toBe(true);
  });

  test('returns true for valid modelId', () => {
    expect(validateModelId('llama-3.1-8b-instant')).toBe(true);
  });

  test('returns false for invalid ID', () => {
    expect(validateModelId('nonexistent')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(validateModelId('')).toBe(false);
  });
});

// =============================================================================
// getModelDisplayName Tests
// =============================================================================

describe('getModelDisplayName', () => {
  test('returns display name for valid ID', () => {
    const name = getModelDisplayName('llama-8b');
    expect(name).toBe('LLaMA 3.1 8B');
  });

  test('returns display name for valid modelId', () => {
    const name = getModelDisplayName('gpt-4o');
    expect(name).toBe('GPT-4o');
  });

  test('returns input string for unknown ID', () => {
    const name = getModelDisplayName('unknown-model');
    expect(name).toBe('unknown-model');
  });
});

// =============================================================================
// createLocalModel Tests
// =============================================================================

describe('createLocalModel', () => {
  test('creates valid local model config', () => {
    const model = createLocalModel({
      id: 'test-local',
      displayName: 'Test Local Model',
      baseModel: 'Qwen/Qwen3-4B',
    });

    expect(model.id).toBe('test-local');
    expect(model.displayName).toBe('Test Local Model');
    expect(model.provider).toBe('local');
    expect(model.modelId).toBe('Qwen/Qwen3-4B');
    expect(model.tier).toBe('standard');
    expect(model.isBaseline).toBe(false);
  });

  test('includes adapter path when specified', () => {
    const model = createLocalModel({
      id: 'trained-v1',
      displayName: 'Trained Model v1',
      baseModel: 'Qwen/Qwen3-4B',
      adapterPath: '/models/trained',
    });

    expect(model.adapterPath).toBe('/models/trained');
  });

  test('uses default vLLM URL when not specified', () => {
    const model = createLocalModel({
      id: 'test',
      displayName: 'Test',
      baseModel: 'Qwen/Qwen3-4B',
    });

    expect(model.vllmUrl).toBe('http://localhost:9001');
  });

  test('uses custom vLLM URL when specified', () => {
    const model = createLocalModel({
      id: 'test',
      displayName: 'Test',
      baseModel: 'Qwen/Qwen3-4B',
      vllmUrl: 'http://custom:8080',
    });

    expect(model.vllmUrl).toBe('http://custom:8080');
  });

  test('includes parameter count when specified', () => {
    const model = createLocalModel({
      id: 'test',
      displayName: 'Test',
      baseModel: 'Qwen/Qwen3-4B',
      parametersBillions: 4,
    });

    expect(model.parametersBillions).toBe(4);
  });

  test('includes metadata with base model and trained flag', () => {
    const model = createLocalModel({
      id: 'test',
      displayName: 'Test',
      baseModel: 'Qwen/Qwen3-4B',
    });

    expect(model.metadata).toBeDefined();
    expect(model.metadata?.baseModel).toBe('Qwen/Qwen3-4B');
    expect(model.metadata?.isTrainedModel).toBe(true);
  });
});

// =============================================================================
// createLocalModelFromEnv Tests
// =============================================================================

describe('createLocalModelFromEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns null when no model path or display name set', () => {
    delete process.env.MODEL_PATH;
    delete process.env.ADAPTER_PATH;
    delete process.env.MODEL_DISPLAY_NAME;

    const model = createLocalModelFromEnv();
    expect(model).toBeNull();
  });

  test('creates model from MODEL_PATH', () => {
    process.env.MODEL_PATH = '/models/trained_v1';
    delete process.env.ADAPTER_PATH;
    delete process.env.MODEL_DISPLAY_NAME;

    const model = createLocalModelFromEnv();

    expect(model).not.toBeNull();
    expect(model?.adapterPath).toBe('/models/trained_v1');
    expect(model?.displayName).toContain('trained_v1');
  });

  test('creates model from ADAPTER_PATH when MODEL_PATH not set', () => {
    delete process.env.MODEL_PATH;
    process.env.ADAPTER_PATH = '/models/adapter_v2';
    delete process.env.MODEL_DISPLAY_NAME;

    const model = createLocalModelFromEnv();

    expect(model).not.toBeNull();
    expect(model?.adapterPath).toBe('/models/adapter_v2');
  });

  test('uses MODEL_DISPLAY_NAME when set', () => {
    process.env.MODEL_PATH = '/models/trained';
    process.env.MODEL_DISPLAY_NAME = 'Custom Display Name';

    const model = createLocalModelFromEnv();

    expect(model?.displayName).toBe('Custom Display Name');
  });

  test('uses BASE_MODEL from environment', () => {
    process.env.MODEL_PATH = '/models/trained';
    process.env.BASE_MODEL = 'Custom/BaseModel';

    const model = createLocalModelFromEnv();

    expect(model?.modelId).toBe('Custom/BaseModel');
  });

  test('uses default base model when BASE_MODEL not set', () => {
    process.env.MODEL_PATH = '/models/trained';
    delete process.env.BASE_MODEL;

    const model = createLocalModelFromEnv();

    expect(model?.modelId).toBe('Qwen/Qwen3-4B');
  });

  test('uses VLLM_URL from environment', () => {
    process.env.MODEL_PATH = '/models/trained';
    process.env.VLLM_URL = 'http://custom:8080';

    const model = createLocalModelFromEnv();

    expect(model?.vllmUrl).toBe('http://custom:8080');
  });

  test('uses default vLLM URL when VLLM_URL not set', () => {
    process.env.MODEL_PATH = '/models/trained';
    delete process.env.VLLM_URL;

    const model = createLocalModelFromEnv();

    expect(model?.vllmUrl).toBe('http://localhost:9001');
  });

  test('creates model with display name only (no path)', () => {
    delete process.env.MODEL_PATH;
    delete process.env.ADAPTER_PATH;
    process.env.MODEL_DISPLAY_NAME = 'Standalone Model';

    const model = createLocalModelFromEnv();

    expect(model).not.toBeNull();
    expect(model?.displayName).toBe('Standalone Model');
    expect(model?.adapterPath).toBeUndefined();
  });
});

// =============================================================================
// Edge Cases and Boundary Tests
// =============================================================================

describe('ModelRegistry Edge Cases', () => {
  test('handles special characters in model ID lookup', () => {
    const model = getModelById('model-with-special-chars!@#');
    expect(model).toBeUndefined();
  });

  test('handles very long model ID lookup', () => {
    const longId = 'a'.repeat(1000);
    const model = getModelById(longId);
    expect(model).toBeUndefined();
  });

  test('createLocalModel with empty strings', () => {
    const model = createLocalModel({
      id: '',
      displayName: '',
      baseModel: '',
    });

    expect(model.id).toBe('');
    expect(model.displayName).toBe('');
    expect(model.modelId).toBe('');
    expect(model.provider).toBe('local');
  });

  test('createLocalModel with special characters', () => {
    const model = createLocalModel({
      id: 'test/model:v1.0',
      displayName: 'Test "Model" <v1.0>',
      baseModel: 'org/model-name',
    });

    expect(model.id).toBe('test/model:v1.0');
    expect(model.displayName).toBe('Test "Model" <v1.0>');
  });
});
