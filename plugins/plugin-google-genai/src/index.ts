import type {
  IAgentRuntime,
  Plugin,
  GenerateTextParams,
  ImageDescriptionParams,
  TextEmbeddingParams,
  ObjectGenerationParams,
} from '@elizaos/core';
import { logger, ModelType } from '@elizaos/core';
import { initializeGoogleGenAI } from './init';
import {
  handleTextSmall,
  handleTextLarge,
  handleTextEmbedding,
  handleImageDescription,
  handleObjectSmall,
  handleObjectLarge,
} from './models';
import { getApiKey } from './utils/config';
import { GoogleGenAI } from '@google/genai';

export * from './types';

/**
 * Defines the Google Generative AI plugin with its name, description, and configuration options.
 * @type {Plugin}
 *
 * Available models as of March 2025:
 * - gemini-2.0-flash-001: Fast, efficient model for everyday tasks
 * - gemini-2.5-pro-exp-03-25: Latest experimental model with advanced reasoning (March 25, 2025)
 * - gemini-2.5-pro-preview-05-06: Preview version from Google I/O 2025
 * - gemini-2.5-pro: General model name for Gemini 2.5 Pro
 * - text-embedding-004: For text embeddings
 */
export const googleGenAIPlugin: Plugin = {
  name: 'google-genai',
  description: 'Google Generative AI plugin for Gemini models',
  config: {
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    GOOGLE_SMALL_MODEL: process.env.GOOGLE_SMALL_MODEL,
    GOOGLE_LARGE_MODEL: process.env.GOOGLE_LARGE_MODEL,
    GOOGLE_IMAGE_MODEL: process.env.GOOGLE_IMAGE_MODEL,
    GOOGLE_EMBEDDING_MODEL: process.env.GOOGLE_EMBEDDING_MODEL,
    SMALL_MODEL: process.env.SMALL_MODEL,
    LARGE_MODEL: process.env.LARGE_MODEL,
    IMAGE_MODEL: process.env.IMAGE_MODEL,
  },
  async init(_config, runtime) {
    // Note: We intentionally don't await here because ElizaOS expects
    // the init method to return quickly. The initializeGoogleGenAI function
    // performs background validation and logging.
    initializeGoogleGenAI(_config, runtime);
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextSmall(runtime, params);
    },
    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextLarge(runtime, params);
    },
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ) => {
      return handleTextEmbedding(runtime, params);
    },
    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ) => {
      return handleImageDescription(runtime, params);
    },
    [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) => {
      return handleObjectSmall(runtime, params);
    },
    [ModelType.OBJECT_LARGE]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) => {
      return handleObjectLarge(runtime, params);
    },
  },
  tests: [
    {
      name: 'google_genai_plugin_tests',
      tests: [
        {
          name: 'google_test_api_key_validation',
          fn: async (runtime: IAgentRuntime) => {
            const apiKey = getApiKey(runtime);
            if (!apiKey) {
              throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set');
            }
            const genAI = new GoogleGenAI({ apiKey });
            const modelList = await genAI.models.list();
            const models = [];
            for await (const model of modelList) {
              models.push(model);
            }
            logger.log(`Available models: ${models.length}`);
          },
        },
        {
          name: 'google_test_text_embedding',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: 'Hello, world!',
              });
              logger.log(`Embedding dimension: ${embedding.length}`);
              if (embedding.length === 0) {
                throw new Error('Failed to generate embedding');
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_embedding: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'google_test_text_small',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log('Generated with TEXT_SMALL:', text);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_small: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'google_test_text_large',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'Explain quantum mechanics in simple terms.',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log('Generated with TEXT_LARGE:', text.substring(0, 100) + '...');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_large: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'google_test_image_description',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const result = await runtime.useModel(
                ModelType.IMAGE_DESCRIPTION,
                'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg'
              );

              if (
                result &&
                typeof result === 'object' &&
                'title' in result &&
                'description' in result
              ) {
                logger.log('Image description:', JSON.stringify(result));
              } else {
                logger.error('Invalid image description result format:', result);
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_image_description: ${message}`);
              throw error;
            }
          },
        },
        {
          name: 'google_test_object_generation',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const schema = {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  age: { type: 'number' },
                  hobbies: { type: 'array', items: { type: 'string' } },
                },
                required: ['name', 'age', 'hobbies'],
              };

              const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
                prompt: 'Generate a person profile with name, age, and hobbies.',
                schema,
              });

              logger.log('Generated object:', result);

              if (!result.name || !result.age || !result.hobbies) {
                throw new Error('Generated object missing required fields');
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_object_generation: ${message}`);
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default googleGenAIPlugin;
