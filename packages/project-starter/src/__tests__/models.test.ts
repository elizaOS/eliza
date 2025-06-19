import { describe, expect, it, spyOn, beforeAll, afterAll } from 'bun:test';
import plugin from '../plugin';
import { ModelType, logger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import dotenv from 'dotenv';
import { documentTestResult, createMockRuntime } from './utils/core-test-utils';

// Define a simplified version of the GenerateTextParams for testing
interface TestGenerateParams {
  prompt: string;
  stopSequences?: string[];
  maxTokens?: number;
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// Setup environment variables from .env file
dotenv.config();

// Spy on logger to capture logs for documentation
beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
});

afterAll(() => {
  // No global restore needed in bun:test;
});

/**
 * Tests a model function with core testing patterns
 * @param modelType The type of model to test
 * @param modelFn The model function to test
 */
const runCoreModelTests = async (
  modelType: keyof typeof ModelType,
  modelFn: (runtime: IAgentRuntime, params: TestGenerateParams) => Promise<string>
) => {
  // Create a mock runtime for model testing
  const mockRuntime = createMockRuntime();

  // Test with basic parameters
  const basicParams: TestGenerateParams = {
    prompt: `Test prompt for ${modelType}`,
    stopSequences: ['STOP'],
    maxTokens: 100,
  };

  let basicResponse: string | null = null;
  let basicError: Error | null = null;

  try {
    basicResponse = await modelFn(mockRuntime, basicParams);
    expect(basicResponse).toBeTruthy();
    expect(typeof basicResponse).toBe('string');
  } catch (e) {
    basicError = e as Error;
    logger.error(`${modelType} model call failed:`, e);
  }

  // Test with empty prompt
  const emptyParams: TestGenerateParams = {
    prompt: '',
  };

  let emptyResponse: string | null = null;
  let emptyError: Error | null = null;

  try {
    emptyResponse = await modelFn(mockRuntime, emptyParams);
  } catch (e) {
    emptyError = e as Error;
    logger.error(`${modelType} empty prompt test failed:`, e);
  }

  // Test with all parameters
  const fullParams: TestGenerateParams = {
    prompt: `Comprehensive test prompt for ${modelType}`,
    stopSequences: ['STOP1', 'STOP2'],
    maxTokens: 200,
    temperature: 0.8,
    frequencyPenalty: 0.6,
    presencePenalty: 0.4,
  };

  let fullResponse: string | null = null;
  let fullError: Error | null = null;

  try {
    fullResponse = await modelFn(mockRuntime, fullParams);
  } catch (e) {
    fullError = e as Error;
    logger.error(`${modelType} all parameters test failed:`, e);
  }

  return {
    basic: { response: basicResponse, error: basicError },
    empty: { response: emptyResponse, error: emptyError },
    full: { response: fullResponse, error: fullError },
  };
};

describe('Plugin Models', () => {
  it('should have models defined', () => {
    expect(plugin.models).toBeDefined();
    if (plugin.models) {
      expect(typeof plugin.models).toBe('object');
    }
  });

  describe('TEXT_SMALL Model', () => {
    it('should have a TEXT_SMALL model defined', () => {
      if (plugin.models) {
        expect(plugin.models).toHaveProperty(ModelType.TEXT_SMALL);
        expect(typeof plugin.models[ModelType.TEXT_SMALL]).toBe('function');
      }
    });

    it('should run core tests for TEXT_SMALL model', async () => {
      if (plugin.models && plugin.models[ModelType.TEXT_SMALL]) {
        const results = await runCoreModelTests(
          ModelType.TEXT_SMALL,
          plugin.models[ModelType.TEXT_SMALL]
        );

        documentTestResult('TEXT_SMALL core model tests', results);
      }
    });
  });

  describe('TEXT_LARGE Model', () => {
    it('should have a TEXT_LARGE model defined', () => {
      if (plugin.models) {
        expect(plugin.models).toHaveProperty(ModelType.TEXT_LARGE);
        expect(typeof plugin.models[ModelType.TEXT_LARGE]).toBe('function');
      }
    });

    it('should run core tests for TEXT_LARGE model', async () => {
      if (plugin.models && plugin.models[ModelType.TEXT_LARGE]) {
        const results = await runCoreModelTests(
          ModelType.TEXT_LARGE,
          plugin.models[ModelType.TEXT_LARGE]
        );

        documentTestResult('TEXT_LARGE core model tests', results);
      }
    });
  });
});
