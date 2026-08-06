import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TRADE_VISION_MODEL,
  DEFAULT_VISION_MODEL,
  defaultModelFor,
  normalizeModelId,
} from './grok-models.js';

describe('model defaults', () => {
  test('defaults to Z.AI GLM models', () => {
    assert.equal(DEFAULT_PROVIDER, 'zai');
    assert.equal(DEFAULT_MODEL, 'glm-5.2');
    assert.equal(DEFAULT_VISION_MODEL, 'glm-5v-turbo');
    assert.equal(DEFAULT_TRADE_VISION_MODEL, 'glm-5v-turbo');
    assert.equal(DEFAULT_IMAGE_MODEL, 'glm-image');
  });

  test('default alias resolves to GLM-5.2', () => {
    assert.equal(normalizeModelId('default'), 'glm-5.2');
    assert.equal(defaultModelFor('code'), 'glm-5.2');
    assert.equal(defaultModelFor('research'), 'glm-5.2');
    assert.equal(defaultModelFor('vision'), 'glm-5v-turbo');
    assert.equal(defaultModelFor('image'), 'glm-image');
  });

  test('OpenRouter Fable aliases resolve to provider model IDs', () => {
    assert.equal(normalizeModelId('fable5'), 'anthropic/claude-fable-5');
    assert.equal(normalizeModelId('fable-latest'), '~anthropic/claude-fable-latest');
  });
});
