import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOpenRouterFableModels,
  getOpenRouterNemoModels,
  getOpenRouterProviderModels,
  OPENROUTER_FABLE5,
  OPENROUTER_FABLE_LATESY,
  OPENROUTER_NEMO_MODEL1,
  OPENROUTER_NEMO_MODEL2,
  OPENROUTER_NEMO_MODEL3,
  selectOpenRouterModel,
} from './openrouter.js';

describe('OpenRouter Nemo model routing', () => {
  test('uses the requested Nemo defaults', () => {
    const models = getOpenRouterNemoModels({});

    assert.equal(models.model1, OPENROUTER_NEMO_MODEL1);
    assert.equal(models.model2, OPENROUTER_NEMO_MODEL2);
    assert.equal(models.model3, OPENROUTER_NEMO_MODEL3);
    assert.equal(models.balanced, OPENROUTER_NEMO_MODEL1);
    assert.equal(models.intelligent, OPENROUTER_NEMO_MODEL2);
    assert.equal(models.fast, OPENROUTER_NEMO_MODEL3);
  });

  test('allows env overrides for all three route slots', () => {
    const models = getOpenRouterNemoModels({
      OPENROUTER_NEMO_MODEL1: 'custom-balanced',
      OPENROUTER_NEMO_MODEL2: 'custom-smart',
      OPENROUTER_NEMO_MODEL3: 'custom-fast',
    });

    assert.equal(models.balanced, 'custom-balanced');
    assert.equal(models.intelligent, 'custom-smart');
    assert.equal(models.fast, 'custom-fast');
  });

  test('uses the requested Fable defaults', () => {
    const models = getOpenRouterFableModels({});

    assert.equal(models.fable5, OPENROUTER_FABLE5);
    assert.equal(models.latest, OPENROUTER_FABLE_LATESY);
  });

  test('allows env overrides for Fable model slots', () => {
    const models = getOpenRouterFableModels({
      OPENROUTER_FABLE5: 'custom-fable-5',
      OPENROUTER_FABLE_LATESY: 'custom-fable-latest',
    });

    assert.equal(models.fable5, 'custom-fable-5');
    assert.equal(models.latest, 'custom-fable-latest');
  });

  test('keeps OPENROUTER_FABLE_LATEST as a corrected Fable latest fallback', () => {
    const models = getOpenRouterFableModels({
      OPENROUTER_FABLE_LATEST: 'custom-corrected-latest',
    });

    assert.equal(models.latest, 'custom-corrected-latest');
  });

  test('returns a combined provider model view', () => {
    const models = getOpenRouterProviderModels({});

    assert.equal(models.model1, OPENROUTER_NEMO_MODEL1);
    assert.equal(models.fable5, OPENROUTER_FABLE5);
    assert.equal(models.latest, OPENROUTER_FABLE_LATESY);
  });

  test('keeps OPENROUTER_FREE_MODEL as a legacy balanced route fallback', () => {
    const models = getOpenRouterNemoModels({
      OPENROUTER_FREE_MODEL: 'legacy-free-model',
    });

    assert.equal(models.balanced, 'legacy-free-model');
  });

  test('routes short/simple prompts to the fast model', () => {
    const selection = selectOpenRouterModel({
      prompt: 'quick summary of this error',
      requestedModel: 'auto',
      env: {},
    });

    assert.equal(selection.route, 'fast');
    assert.equal(selection.model, OPENROUTER_NEMO_MODEL3);
    assert.equal(selection.reasoning, undefined);
  });

  test('routes complex coding prompts to the intelligent model', () => {
    const selection = selectOpenRouterModel({
      prompt: 'Build a production Solana Anchor program with security checks and tests',
      mode: 'code',
      requestedModel: 'grok-4.3',
      env: {},
    });

    assert.equal(selection.route, 'intelligent');
    assert.equal(selection.model, OPENROUTER_NEMO_MODEL2);
    assert.equal(selection.reasoning?.effort, 'high');
  });

  test('routes research mode to the intelligent model', () => {
    const selection = selectOpenRouterModel({
      prompt: 'compare these market-making strategies',
      mode: 'research',
      requestedModel: 'auto',
      env: {},
    });

    assert.equal(selection.route, 'intelligent');
    assert.equal(selection.model, OPENROUTER_NEMO_MODEL2);
  });

  test('respects explicit OpenRouter model IDs', () => {
    const selection = selectOpenRouterModel({
      prompt: 'quick answer',
      requestedModel: 'openai/gpt-4.1-mini',
      env: {},
    });

    assert.equal(selection.explicit, true);
    assert.equal(selection.route, 'explicit');
    assert.equal(selection.model, 'openai/gpt-4.1-mini');
  });

  test('resolves explicit Fable aliases through env-backed slots', () => {
    const selection = selectOpenRouterModel({
      prompt: 'review this code',
      requestedModel: 'fable5',
      env: {
        OPENROUTER_FABLE5: 'custom-fable-5',
      },
    });

    assert.equal(selection.explicit, true);
    assert.equal(selection.model, 'custom-fable-5');
  });

  test('resolves the Fable latest alias through the requested env name', () => {
    const selection = selectOpenRouterModel({
      prompt: 'review this code',
      requestedModel: 'fable-latest',
      env: {
        OPENROUTER_FABLE_LATESY: 'custom-fable-latest',
      },
    });

    assert.equal(selection.explicit, true);
    assert.equal(selection.model, 'custom-fable-latest');
  });
});
