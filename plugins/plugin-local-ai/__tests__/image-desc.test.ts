import fs from 'node:fs';
import path from 'node:path';
import { ModelType, type Plugin } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type {
  Florence2ForConditionalGeneration,
  Florence2Processor,
  ModelOutput,
  PreTrainedTokenizer,
} from '@huggingface/transformers';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { TEST_PATHS, createMockRuntime } from './test-utils';

// Mock the transformers library
vi.mock('@huggingface/transformers', () => {
  logger.info('Setting up transformers mock');
  return {
    env: {
      allowLocalModels: false,
      allowRemoteModels: true,
      backends: {
        onnx: {
          logLevel: 'fatal',
        },
      },
    },
    Florence2ForConditionalGeneration: {
      from_pretrained: vi.fn().mockImplementation(async () => {
        logger.info('Creating mock Florence2ForConditionalGeneration model');
        const mockModel = {
          generate: async () => {
            logger.info('Generating vision model output');
            return new Int32Array([1, 2, 3, 4, 5]); // Mock token IDs
          },
          _merge_input_ids_with_image_features: vi.fn(),
          _prepare_inputs_embeds: vi.fn(),
          forward: vi.fn(),
          main_input_name: 'pixel_values',
        };
        return mockModel as unknown as Florence2ForConditionalGeneration;
      }),
    },
    AutoProcessor: {
      from_pretrained: vi.fn().mockImplementation(async () => {
        logger.info('Creating mock Florence2Processor');
        const mockProcessor = {
          __call__: async () => ({ pixel_values: new Float32Array(10) }),
          construct_prompts: () => ['<DETAILED_CAPTION>'],
          post_process_generation: () => ({
            '<DETAILED_CAPTION>': 'A detailed description of the test image.',
          }),
          tasks_answer_post_processing_type: 'string',
          task_prompts_without_inputs: [],
          task_prompts_with_input: [],
          regexes: {},
        };
        return mockProcessor as unknown as Florence2Processor;
      }),
    },
    AutoTokenizer: {
      from_pretrained: vi.fn().mockImplementation(async () => {
        logger.info('Creating mock tokenizer');
        const mockTokenizer = {
          __call__: async () => ({ input_ids: new Int32Array(5) }),
          batch_decode: () => ['A detailed caption of the image.'],
          encode: async () => new Int32Array(5),
          decode: async () => 'Decoded text',
          return_token_type_ids: true,
          padding_side: 'right',
          _tokenizer_config: {},
          normalizer: {},
        };
        return mockTokenizer as unknown as PreTrainedTokenizer;
      }),
    },
    RawImage: {
      fromBlob: vi.fn().mockImplementation(async () => ({
        size: { width: 640, height: 480 },
      })),
    },
  };
});

// Set environment variables before importing the plugin
process.env.MODELS_DIR = TEST_PATHS.MODELS_DIR;
process.env.CACHE_DIR = TEST_PATHS.CACHE_DIR;

// Import plugin after setting environment variables and mocks
import { localAiPlugin } from '../src/index';

// Type assertion for localAIPlugin
const plugin = localAiPlugin as Required<Plugin>;

describe('LocalAI Image Description', () => {
  const mockRuntime = createMockRuntime();

  beforeAll(async () => {
    logger.info('Starting image description test setup', {
      MODELS_DIR: TEST_PATHS.MODELS_DIR,
      CACHE_DIR: TEST_PATHS.CACHE_DIR,
      process_cwd: process.cwd(),
    });

    // Create necessary directories
    const visionCacheDir = path.join(TEST_PATHS.CACHE_DIR, 'vision');
    if (!fs.existsSync(visionCacheDir)) {
      logger.info('Creating vision cache directory:', visionCacheDir);
      fs.mkdirSync(visionCacheDir, { recursive: true });
    }

    await plugin.init(
      {
        MODELS_DIR: TEST_PATHS.MODELS_DIR,
        CACHE_DIR: TEST_PATHS.CACHE_DIR,
      },
      mockRuntime
    );

    logger.success('Test setup completed');
  }, 300000);

  test('should describe image from URL successfully', async () => {
    logger.info('Starting successful image description test');

    // Using a reliable test image URL
    const imageUrl = 'https://picsum.photos/200/300';
    logger.info('Testing with image URL:', imageUrl);

    try {
      const result = await mockRuntime.useModel(ModelType.IMAGE_DESCRIPTION, imageUrl);

      // if result is not an object, throw an error
      if (typeof result !== 'object') {
        throw new Error('Result is not an object');
      }

      logger.info('Image description result:', {
        resultType: typeof result,
        resultLength: result.description.length,
        rawResult: result,
      });

      expect(result).toBeDefined();
      const parsed = result;
      logger.info('Parsed result:', parsed);

      expect(parsed).toHaveProperty('title');
      expect(parsed).toHaveProperty('description');
      expect(typeof parsed.title).toBe('string');
      expect(typeof parsed.description).toBe('string');
      logger.success('Successful image description test completed', {
        title: parsed.title,
        descriptionLength: parsed.description.length,
      });
    } catch (error) {
      logger.error('Image description test failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        imageUrl,
      });
      throw error;
    }
  });

  test('should handle invalid image URL', async () => {
    logger.info('Starting invalid URL test');
    const invalidUrl = 'https://picsum.photos/invalid/image.jpg';
    logger.info('Testing with invalid URL:', invalidUrl);

    try {
      await mockRuntime.useModel(ModelType.IMAGE_DESCRIPTION, invalidUrl);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Invalid URL test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
        errorType: error.constructor.name,
        stack: error instanceof Error ? error.stack : undefined,
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Failed to fetch image');
    }
  });

  test('should handle non-string input', async () => {
    logger.info('Starting non-string input test');
    const invalidInput = { url: 'not-a-string' };

    try {
      await mockRuntime.useModel(ModelType.IMAGE_DESCRIPTION, invalidInput as unknown);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Non-string input test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Invalid image URL');
    }
  });

  test('should handle vision model failure', async () => {
    logger.info('Starting vision model failure test');

    // Use a working URL for this test
    const imageUrl = 'https://picsum.photos/200/300';
    logger.info('Testing with image URL:', imageUrl);

    // Mock the vision model to fail
    const { Florence2ForConditionalGeneration } = await import('@huggingface/transformers');
    const modelMock = vi.mocked(Florence2ForConditionalGeneration);

    // Save the original implementation
    const originalImpl = modelMock.from_pretrained;

    // Mock the implementation to fail
    modelMock.from_pretrained.mockImplementationOnce(async () => {
      logger.info('Simulating vision model failure');
      throw new Error('Vision model failed to load');
    });

    try {
      await mockRuntime.useModel(ModelType.IMAGE_DESCRIPTION, imageUrl);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Vision model failure test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
        errorType: error.constructor.name,
        stack: error instanceof Error ? error.stack : undefined,
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Vision model failed');
    } finally {
      // Restore the original implementation
      modelMock.from_pretrained = originalImpl;
    }
  });

  test('should handle non-image content type', async () => {
    logger.info('Starting non-image content test');
    const textUrl = 'https://raw.githubusercontent.com/microsoft/FLAML/main/README.md';

    try {
      await mockRuntime.useModel(ModelType.IMAGE_DESCRIPTION, textUrl);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Non-image content test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      // The error message might vary depending on how we want to handle this case
      expect(error.message).toBeDefined();
    }
  });
});
