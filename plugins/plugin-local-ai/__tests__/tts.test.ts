import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ModelType, type Plugin } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { LlamaContext, LlamaContextSequence, LlamaModel } from 'node-llama-cpp';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { TEST_PATHS, createMockRuntime } from './test-utils';

// Mock the node-llama-cpp
vi.mock('node-llama-cpp', () => {
  logger.info('Setting up node-llama-cpp mock for TTS');
  return {
    getLlama: vi.fn().mockImplementation(async () => {
      logger.info('Creating mock Llama instance for TTS');
      return {
        loadModel: vi.fn().mockImplementation(async () => {
          logger.info('Creating mock LlamaModel for TTS');
          return {
            createContext: vi.fn().mockImplementation(async () => {
              logger.info('Creating mock LlamaContext for TTS');
              return {
                getSequence: vi.fn().mockImplementation(() => {
                  logger.info('Creating mock LlamaContextSequence for TTS');
                  return {
                    evaluate: vi.fn().mockImplementation(async function* () {
                      yield 1;
                      yield 2;
                      yield 3;
                    }),
                  } as unknown as LlamaContextSequence;
                }),
              } as unknown as LlamaContext;
            }),
          } as unknown as LlamaModel;
        }),
      };
    }),
  };
});

// Set environment variables before importing the plugin
process.env.MODELS_DIR = TEST_PATHS.MODELS_DIR;
process.env.CACHE_DIR = TEST_PATHS.CACHE_DIR;

// Import plugin after setting environment variables and mocks
import { localAiPlugin } from '../src/index';

// Type assertion for localAIPlugin
const plugin = localAiPlugin as Required<Plugin>;

describe('LocalAI Text-to-Speech', () => {
  const mockRuntime = createMockRuntime();

  beforeAll(async () => {
    logger.info('Starting TTS test setup', {
      MODELS_DIR: TEST_PATHS.MODELS_DIR,
      CACHE_DIR: TEST_PATHS.CACHE_DIR,
      process_cwd: process.cwd(),
    });

    // Create necessary directories
    const ttsCacheDir = path.join(TEST_PATHS.CACHE_DIR, 'tts');
    if (!fs.existsSync(ttsCacheDir)) {
      logger.info('Creating TTS cache directory:', ttsCacheDir);
      fs.mkdirSync(ttsCacheDir, { recursive: true });
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

  test('should handle model initialization failure', async () => {
    logger.info('Starting model initialization failure test');

    const { getLlama } = await import('node-llama-cpp');
    const llamaMock = vi.mocked(getLlama);

    // Save original implementation
    const originalImpl = llamaMock.getMockImplementation();

    // Mock implementation to fail
    llamaMock.mockRejectedValueOnce(new Error('Failed to initialize TTS model'));

    try {
      await mockRuntime.useModel(ModelType.TEXT_TO_SPEECH, 'Test text');
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Model initialization failure test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Failed to initialize TTS model');
    } finally {
      // Restore original implementation
      if (originalImpl) {
        llamaMock.mockImplementation(originalImpl);
      }
    }
  });

  test('should handle audio generation failure', async () => {
    logger.info('Starting audio generation failure test');

    const { getLlama } = await import('node-llama-cpp');
    const llamaMock = vi.mocked(getLlama);

    // Save original implementation
    const originalImpl = llamaMock.getMockImplementation();

    // Mock implementation to fail during audio generation
    llamaMock.mockRejectedValueOnce(new Error('Audio generation failed'));

    try {
      await mockRuntime.useModel(ModelType.TEXT_TO_SPEECH, 'Test text');
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Audio generation failure test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('Audio generation failed');
    } finally {
      // Restore original implementation
      if (originalImpl) {
        llamaMock.mockImplementation(originalImpl);
      }
    }
  });

  test('should generate speech from text successfully', async () => {
    logger.info('Starting successful TTS test');

    const testText = 'This is a test of the text to speech system.';
    logger.info('Testing with text:', testText);

    try {
      const result = await mockRuntime.useModel(ModelType.TEXT_TO_SPEECH, testText);
      logger.info('TTS generation result type:', typeof result);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Readable);

      // Test stream readability
      let dataReceived = false;
      (result as Readable).on('data', (chunk) => {
        logger.info('Received audio data chunk:', { size: chunk.length });
        dataReceived = true;
      });

      await new Promise((resolve, reject) => {
        (result as Readable).on('end', () => {
          if (!dataReceived) {
            reject(new Error('No audio data received from stream'));
          } else {
            resolve(true);
          }
        });
        (result as Readable).on('error', reject);
      });

      logger.success('Successful TTS test completed');
    } catch (error) {
      logger.error('TTS test failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  });

  test('should handle empty text input', async () => {
    logger.info('Starting empty text test');
    const emptyText = '';

    try {
      await mockRuntime.useModel(ModelType.TEXT_TO_SPEECH, emptyText);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Empty text test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('empty text');
    }
  });

  test('should handle non-string input', async () => {
    logger.info('Starting non-string input test');
    const invalidInput = { text: 'not-a-string' };

    try {
      await mockRuntime.useModel(ModelType.TEXT_TO_SPEECH, invalidInput as unknown as string);
      throw new Error("Should have failed but didn't");
    } catch (error) {
      logger.info('Non-string input test failed as expected:', {
        error: error instanceof Error ? error.message : String(error),
      });
      expect(error).toBeDefined();
      expect(error.message).toContain('invalid input');
    }
  });
});
