/**
 * OpenRouter plugin definition for elizaOS.
 */

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
 * OpenRouter plugin for elizaOS.
 *
 * Provides integration with OpenRouter's multi-model AI gateway for:
 * - Text generation (small and large)
 * - Object/JSON generation
 * - Image description and generation
 * - Text embeddings
 */
export const openrouterPlugin: Plugin = {
  name: 'openrouter',
  description: 'OpenRouter multi-model AI gateway plugin',

  config: {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? null,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL ?? null,
    OPENROUTER_SMALL_MODEL: process.env.OPENROUTER_SMALL_MODEL ?? null,
    OPENROUTER_LARGE_MODEL: process.env.OPENROUTER_LARGE_MODEL ?? null,
    OPENROUTER_IMAGE_MODEL: process.env.OPENROUTER_IMAGE_MODEL ?? null,
    OPENROUTER_IMAGE_GENERATION_MODEL: process.env.OPENROUTER_IMAGE_GENERATION_MODEL ?? null,
    OPENROUTER_EMBEDDING_MODEL: process.env.OPENROUTER_EMBEDDING_MODEL ?? null,
    OPENROUTER_EMBEDDING_DIMENSIONS: process.env.OPENROUTER_EMBEDDING_DIMENSIONS ?? null,
    OPENROUTER_AUTO_CLEANUP_IMAGES: process.env.OPENROUTER_AUTO_CLEANUP_IMAGES ?? null,
    SMALL_MODEL: process.env.SMALL_MODEL ?? null,
    LARGE_MODEL: process.env.LARGE_MODEL ?? null,
    IMAGE_MODEL: process.env.IMAGE_MODEL ?? null,
    IMAGE_GENERATION_MODEL: process.env.IMAGE_GENERATION_MODEL ?? null,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? null,
    EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS ?? null,
  },

  async init(config: Record<string, unknown>, runtime: IAgentRuntime) {
    initializeOpenRouter(config, runtime);
  },

  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
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
      const description = await handleImageDescription(runtime, params);
      // Return expected format with title and description
      return { title: '', description };
    },

    [ModelType.IMAGE]: async (runtime: IAgentRuntime, params: ImageGenerationParams) => {
      const result = await handleImageGeneration(runtime, params);
      // Return expected format as array of {url}
      return [{ url: result.imageUrl }];
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
