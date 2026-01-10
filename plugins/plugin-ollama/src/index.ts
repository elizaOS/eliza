import type { ObjectGenerationParams, Plugin, TextEmbeddingParams } from '@elizaos/core';
import { type GenerateTextParams, ModelType, logger } from '@elizaos/core';
import { generateObject, generateText, embed } from 'ai';
import { createOllama } from 'ollama-ai-provider';

// Default Ollama API URL
const OLLAMA_API_URL = 'http://localhost:11434/api';

/**
 * Retrieves the Ollama API base URL from runtime settings.
 *
 * If the API endpoint is not set in the runtime, defaults to the standard Ollama URL.
 * The URL should include the /api path for ollama-ai-provider compatibility.
 *
 * @returns The base URL for the Ollama API.
 */
function getBaseURL(runtime: { getSetting: (key: string) => string | undefined }): string {
  const apiEndpoint =
    runtime.getSetting('OLLAMA_API_ENDPOINT') ||
    runtime.getSetting('OLLAMA_API_URL') ||
    OLLAMA_API_URL;

  // Ensure the URL ends with /api for ollama-ai-provider
  if (!apiEndpoint.endsWith('/api')) {
    return apiEndpoint.endsWith('/') ? `${apiEndpoint}api` : `${apiEndpoint}/api`;
  }
  return apiEndpoint;
}

/**
 * Ensures that the specified Ollama model is available locally, downloading it if necessary.
 *
 * Checks for the presence of the model via the Ollama API and attempts to download it if not found. Logs progress and errors during the process.
 */
async function ensureModelAvailable(
  runtime: {
    getSetting: (key: string) => string | undefined;
    fetch?: typeof fetch;
  },
  model: string,
  providedBaseURL?: string
) {
  const baseURL = providedBaseURL || getBaseURL(runtime);
  // Remove /api suffix for direct API calls
  const apiBase = baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;
  try {
    const showRes = await fetch(`${apiBase}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (showRes.ok) return;
    logger.info(`[Ollama] Model ${model} not found locally. Downloading...`);
    const pullRes = await fetch(`${apiBase}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
    });
    if (!pullRes.ok) {
      logger.error(`Failed to pull model ${model}: ${pullRes.statusText}`);
    } else {
      logger.info(`[Ollama] Downloaded model ${model}`);
    }
  } catch (err) {
    logger.error({ error: err }, 'Error ensuring model availability');
  }
}

/**
 * Generates text from the Ollama API using the specified model and parameters.
 *
 * Returns the generated text, or an error message if generation fails.
 */
async function generateOllamaText(
  ollama: ReturnType<typeof createOllama>,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
  }
) {
  try {
    const { text: ollamaResponse } = await generateText({
      model: ollama(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences,
    });
    return ollamaResponse;
  } catch (error: unknown) {
    logger.error({ error }, 'Error in generateOllamaText');
    return 'Error generating text. Please try again later.';
  }
}

/**
 * Generates an object from the Ollama API using the specified model and parameters.
 *
 * Returns the generated object, or an empty object if generation fails.
 */
async function generateOllamaObject(
  ollama: ReturnType<typeof createOllama>,
  model: string,
  params: ObjectGenerationParams
) {
  try {
    const { object } = await generateObject({
      model: ollama(model),
      output: 'no-schema',
      prompt: params.prompt,
      temperature: params.temperature,
    });
    return object;
  } catch (error: unknown) {
    logger.error({ error }, 'Error generating object');
    return {};
  }
}

export const ollamaPlugin: Plugin = {
  name: 'ollama',
  description: 'Ollama plugin',
  config: {
    OLLAMA_API_ENDPOINT: process.env.OLLAMA_API_ENDPOINT,
    OLLAMA_SMALL_MODEL: process.env.OLLAMA_SMALL_MODEL,
    OLLAMA_MEDIUM_MODEL: process.env.OLLAMA_MEDIUM_MODEL,
    OLLAMA_LARGE_MODEL: process.env.OLLAMA_LARGE_MODEL,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL,
  },
  async init(_config, runtime) {
    const baseURL = getBaseURL(runtime);

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
      // Remove /api suffix for direct API calls
      const apiBase = baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;
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
        'Ollama functionality will be limited until a valid endpoint is provided - Make sure Ollama is running at ${baseURL}'
      );
    }
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      try {
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL,
        });

        const modelName = runtime.getSetting('OLLAMA_EMBEDDING_MODEL') || 'nomic-embed-text:latest';
        logger.log(`[Ollama] Using TEXT_EMBEDDING model: ${modelName}`);
        await ensureModelAvailable(runtime, modelName, baseURL);
        const text =
          typeof params === 'string'
            ? params
            : params
              ? (params as TextEmbeddingParams).text || ''
              : '';

        // If no text is provided (e.g., for dimension detection), use a default text
        const embeddingText = text || 'test';

        if (!text) {
          logger.debug(
            'No text provided for embedding, using default text for dimension detection'
          );
        }

        // Use ollama.embedding() as shown in the docs
        try {
          const { embedding } = await embed({
            model: ollama.embedding(modelName),
            value: embeddingText,
          });
          return embedding;
        } catch (embeddingError) {
          logger.error({ error: embeddingError }, 'Error generating embedding');
          return Array(1536).fill(0);
        }
      } catch (error) {
        logger.error({ error }, 'Error in TEXT_EMBEDDING model');
        // Return a fallback vector rather than crashing
        return Array(1536).fill(0);
      }
    },
    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }: GenerateTextParams) => {
      try {
        const temperature = 0.7;
        const frequency_penalty = 0.7;
        const presence_penalty = 0.7;
        const max_response_length = 8000;
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL,
        });

        const model =
          runtime.getSetting('OLLAMA_SMALL_MODEL') ||
          runtime.getSetting('SMALL_MODEL') ||
          'gemma3:latest';

        logger.log(`[Ollama] Using TEXT_SMALL model: ${model}`);
        await ensureModelAvailable(runtime, model, baseURL);
        logger.log('generating text');
        logger.log(prompt);

        return await generateOllamaText(ollama, model, {
          prompt,
          system: runtime.character?.system || undefined,
          temperature,
          maxTokens: max_response_length,
          frequencyPenalty: frequency_penalty,
          presencePenalty: presence_penalty,
          stopSequences,
        });
      } catch (error) {
        logger.error({ error }, 'Error in TEXT_SMALL model');
        return 'Error generating text. Please try again later.';
      }
    },
    [ModelType.TEXT_LARGE]: async (
      runtime,
      {
        prompt,
        stopSequences = [],
        maxTokens = 8192,
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
      }: GenerateTextParams
    ) => {
      try {
        const model =
          runtime.getSetting('OLLAMA_LARGE_MODEL') ||
          runtime.getSetting('LARGE_MODEL') ||
          'gemma3:latest';
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL,
        });

        logger.log(`[Ollama] Using TEXT_LARGE model: ${model}`);
        await ensureModelAvailable(runtime, model, baseURL);
        return await generateOllamaText(ollama, model, {
          prompt,
          system: runtime.character?.system || undefined,
          temperature,
          maxTokens,
          frequencyPenalty,
          presencePenalty,
          stopSequences,
        });
      } catch (error) {
        logger.error({ error }, 'Error in TEXT_LARGE model');
        return 'Error generating text. Please try again later.';
      }
    },
    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      try {
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL,
        });
        const model =
          runtime.getSetting('OLLAMA_SMALL_MODEL') ||
          runtime.getSetting('SMALL_MODEL') ||
          'gemma3:latest';

        logger.log(`[Ollama] Using OBJECT_SMALL model: ${model}`);
        await ensureModelAvailable(runtime, model, baseURL);
        if (params.schema) {
          logger.info('Using OBJECT_SMALL without schema validation');
        }

        return await generateOllamaObject(ollama, model, params);
      } catch (error) {
        logger.error({ error }, 'Error in OBJECT_SMALL model');
        // Return empty object instead of crashing
        return {};
      }
    },
    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      try {
        const baseURL = getBaseURL(runtime);
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL,
        });
        const model =
          runtime.getSetting('OLLAMA_LARGE_MODEL') ||
          runtime.getSetting('LARGE_MODEL') ||
          'gemma3:latest';

        logger.log(`[Ollama] Using OBJECT_LARGE model: ${model}`);
        await ensureModelAvailable(runtime, model, baseURL);
        if (params.schema) {
          logger.info('Using OBJECT_LARGE without schema validation');
        }

        return await generateOllamaObject(ollama, model, params);
      } catch (error) {
        logger.error({ error }, 'Error in OBJECT_LARGE model');
        // Return empty object instead of crashing
        return {};
      }
    },
  },
  tests: [
    {
      name: 'ollama_plugin_tests',
      tests: [
        {
          name: 'ollama_test_url_validation',
          fn: async (runtime) => {
            try {
              const baseURL = getBaseURL(runtime);
              // Remove /api suffix for direct API calls
              const apiBase = baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;
              const response = await fetch(`${apiBase}/api/tags`);
              const data = await response.json();
              const modelCount =
                data && typeof data === 'object' && 'models' in data && Array.isArray(data.models)
                  ? data.models.length
                  : 0;
              logger.log(`Models Available: ${modelCount}`);
              if (!response.ok) {
                logger.error(`Failed to validate Ollama API: ${response.statusText}`);
                return;
              }
            } catch (error) {
              logger.error({ error }, 'Error in ollama_test_url_validation');
            }
          },
        },
        {
          name: 'ollama_test_text_embedding',
          fn: async (runtime) => {
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
          fn: async (runtime) => {
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
          fn: async (runtime) => {
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
          fn: async (runtime) => {
            try {
              const object = await runtime.useModel(ModelType.OBJECT_SMALL, {
                prompt:
                  'Generate a JSON object representing a user profile with name, age, and hobbies',
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
          fn: async (runtime) => {
            try {
              const object = await runtime.useModel(ModelType.OBJECT_LARGE, {
                prompt:
                  'Generate a detailed JSON object representing a restaurant with name, cuisine type, menu items with prices, and customer reviews',
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
export default ollamaPlugin;
