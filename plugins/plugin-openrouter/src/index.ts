import {
  ModelType,
  logger,
  type Plugin,
  type IAgentRuntime,
  type GenerateTextParams,
  type ObjectGenerationParams,
  type ImageDescriptionParams,
  type ImageGenerationParams,
  type TextEmbeddingParams,
} from '@elizaos/core';
import { initializeOpenRouter } from './init';
import { handleTextSmall, handleTextLarge } from './models/text';
import { handleObjectSmall, handleObjectLarge } from './models/object';
import { handleImageDescription, handleImageGeneration } from './models/image';
import { handleTextEmbedding } from './models/embedding';

/**
 * Defines the OpenRouter plugin with its name, description, and configuration options.
 * @type {Plugin}
 */
export const openrouterPlugin: Plugin = {
  name: 'openrouter',
  description: 'OpenRouter plugin',
  config: {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    OPENROUTER_SMALL_MODEL: process.env.OPENROUTER_SMALL_MODEL,
    OPENROUTER_LARGE_MODEL: process.env.OPENROUTER_LARGE_MODEL,
    OPENROUTER_IMAGE_MODEL: process.env.OPENROUTER_IMAGE_MODEL,
    OPENROUTER_IMAGE_GENERATION_MODEL: process.env.OPENROUTER_IMAGE_GENERATION_MODEL,
    OPENROUTER_EMBEDDING_MODEL: process.env.OPENROUTER_EMBEDDING_MODEL,
    OPENROUTER_EMBEDDING_DIMENSIONS: process.env.OPENROUTER_EMBEDDING_DIMENSIONS,
    OPENROUTER_AUTO_CLEANUP_IMAGES: process.env.OPENROUTER_AUTO_CLEANUP_IMAGES,
    SMALL_MODEL: process.env.SMALL_MODEL,
    LARGE_MODEL: process.env.LARGE_MODEL,
    IMAGE_MODEL: process.env.IMAGE_MODEL,
    IMAGE_GENERATION_MODEL: process.env.IMAGE_GENERATION_MODEL,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS,
  },
  async init(config, runtime) {
    // Note: We intentionally don't await here because ElizaOS expects
    // the init method to return quickly. The initializeOpenRouter function
    // only performs synchronous validation and logging, so it's safe to
    // call without await. This prevents blocking the plugin initialization.
    initializeOpenRouter(config, runtime);
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ) => {
      return handleTextSmall(runtime, params);
    },
    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ) => {
      return handleTextLarge(runtime, params);
    },
    [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) => {
      return handleObjectSmall(runtime, params);
    },
    [ModelType.OBJECT_LARGE]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) => {
      return handleObjectLarge(runtime, params);
    },
    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ) => {
      return handleImageDescription(runtime, params);
    },
    [ModelType.IMAGE]: async (runtime: IAgentRuntime, params: ImageGenerationParams) => {
      return handleImageGeneration(runtime, params);
    },
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ) => {
      return handleTextEmbedding(runtime, params);
    },
  },
  tests: [
    {
      name: 'openrouter_plugin_tests',
      tests: [
        {
          name: 'openrouter_test_text_small',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log({ text }, 'generated with test_text_small');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_small: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'openrouter_test_text_large',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log({ text }, 'generated with test_text_large');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_large: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'openrouter_test_text_generation_large',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const result = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'Say hello in 5 words.',
              });
              if (!result || result.length === 0) {
                throw new Error('Text generation returned empty result');
              }
              logger.log({ result }, 'Text generation test completed');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in openrouter_test_text_generation_large: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'openrouter_test_streaming',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const chunks: string[] = [];
              const result = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'Count from 1 to 5.',
                onStreamChunk: (chunk: string) => {
                  chunks.push(chunk);
                },
              });
              if (!result || result.length === 0) {
                throw new Error('Streaming returned empty result');
              }
              if (chunks.length === 0) {
                throw new Error('No streaming chunks received');
              }
              logger.log({ chunks: chunks.length, result: result.substring(0, 50) }, 'Streaming test completed');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in openrouter_test_streaming: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'openrouter_test_object_small',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
                prompt: 'Create a simple JSON object with a message field saying hello',
                schema: { type: 'object' },
              });
              logger.log({ result }, 'Generated object with test_object_small');
              if (!result || (typeof result === 'object' && 'error' in result)) {
                throw new Error('Failed to generate object');
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_object_small: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'openrouter_test_text_embedding',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: 'Hello, world!',
              });
              logger.log({ embedding }, 'embedding');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_embedding: ${message}`);
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default openrouterPlugin;
