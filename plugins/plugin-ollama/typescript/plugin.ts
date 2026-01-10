/**
 * Ollama plugin definition for elizaOS.
 */

import type {
  Plugin,
  IAgentRuntime,
  GenerateTextParams,
  ObjectGenerationParams,
  TextEmbeddingParams,
} from '@elizaos/core';
import { ModelType, logger } from '@elizaos/core';

// Disable AI SDK warning logging by default (can be overridden by setting to true)
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;

import { handleTextSmall, handleTextLarge } from './models/text';
import { handleObjectSmall, handleObjectLarge } from './models/object';
import { handleTextEmbedding } from './models/embedding';
import { getBaseURL, getApiBase } from './utils/config';

/**
 * Ollama plugin for elizaOS.
 *
 * Provides integration with locally-hosted Ollama models for:
 * - Text generation (small and large)
 * - Object/JSON generation
 * - Text embeddings
 */
export const ollamaPlugin: Plugin = {
  name: 'ollama',
  description: 'Ollama plugin for local LLM inference',

  config: {
    OLLAMA_API_ENDPOINT: process.env.OLLAMA_API_ENDPOINT ?? null,
    OLLAMA_SMALL_MODEL: process.env.OLLAMA_SMALL_MODEL ?? null,
    OLLAMA_MEDIUM_MODEL: process.env.OLLAMA_MEDIUM_MODEL ?? null,
    OLLAMA_LARGE_MODEL: process.env.OLLAMA_LARGE_MODEL ?? null,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL ?? null,
  },

  async init(_config, runtime) {
    const baseURL = getBaseURL(runtime);
    const apiBase = getApiBase(runtime);

    // Check if endpoint is configured
    if (!baseURL || baseURL === 'http://localhost:11434/api') {
      const endpoint = runtime.getSetting('OLLAMA_API_ENDPOINT');
      if (!endpoint) {
        logger.warn(
          'OLLAMA_API_ENDPOINT is not set in environment - Ollama functionality will use default localhost:11434'
        );
      }
    }

    try {
      // Validate Ollama API endpoint by checking if it's accessible
      const response = await fetch(`${apiBase}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        logger.warn(`Ollama API endpoint validation failed: ${response.statusText}`);
        logger.warn('Ollama functionality will be limited until a valid endpoint is provided');
      } else {
        const data = (await response.json()) as {
          models?: Array<{ name: string }>;
        };
        const modelCount = data?.models?.length || 0;
        logger.log(
          `Ollama API endpoint validated successfully. Found ${modelCount} models available.`
        );
      }
    } catch (fetchError: unknown) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.warn(`Error validating Ollama API endpoint: ${message}`);
      logger.warn(
        `Ollama functionality will be limited until a valid endpoint is provided - Make sure Ollama is running at ${baseURL}`
      );
    }
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextLarge(runtime, params);
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, unknown>> => {
      return handleObjectSmall(runtime, params);
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, unknown>> => {
      return handleObjectLarge(runtime, params);
    },
  },

  tests: [
    {
      name: 'ollama_plugin_tests',
      tests: [
        {
          name: 'ollama_test_url_validation',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const apiBase = getApiBase(runtime);
              const response = await fetch(`${apiBase}/api/tags`);
              const data = await response.json();
              const modelCount =
                data && typeof data === 'object' && 'models' in data && Array.isArray(data.models)
                  ? data.models.length
                  : 0;
              logger.log(`Models Available: ${modelCount}`);
              if (!response.ok) {
                logger.error(`Failed to validate Ollama API: ${response.statusText}`);
              }
            } catch (error) {
              logger.error({ error }, 'Error in ollama_test_url_validation');
            }
          },
        },
        {
          name: 'ollama_test_text_embedding',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: 'Hello, world!',
              });
              logger.log({ embedding }, 'Generated embedding');
            } catch (error) {
              logger.error({ error }, 'Error in test_text_embedding');
            }
          },
        },
        {
          name: 'ollama_test_text_large',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                logger.error('Failed to generate text');
                return;
              }
              logger.log({ text }, 'Generated with test_text_large');
            } catch (error) {
              logger.error({ error }, 'Error in test_text_large');
            }
          },
        },
        {
          name: 'ollama_test_text_small',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                logger.error('Failed to generate text');
                return;
              }
              logger.log({ text }, 'Generated with test_text_small');
            } catch (error) {
              logger.error({ error }, 'Error in test_text_small');
            }
          },
        },
        {
          name: 'ollama_test_object_small',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const object = await runtime.useModel(ModelType.OBJECT_SMALL, {
                prompt: 'Generate a JSON object representing a user profile with name, age, and hobbies',
                temperature: 0.7,
                schema: undefined,
              });
              logger.log({ object }, 'Generated object');
            } catch (error) {
              logger.error({ error }, 'Error in test_object_small');
            }
          },
        },
        {
          name: 'ollama_test_object_large',
          fn: async (runtime: IAgentRuntime) => {
            try {
              const object = await runtime.useModel(ModelType.OBJECT_LARGE, {
                prompt: 'Generate a detailed JSON object representing a restaurant with name, cuisine type, menu items with prices, and customer reviews',
                temperature: 0.7,
                schema: undefined,
              });
              logger.log({ object }, 'Generated object');
            } catch (error) {
              logger.error({ error }, 'Error in test_object_large');
            }
          },
        },
      ],
    },
  ],
};

