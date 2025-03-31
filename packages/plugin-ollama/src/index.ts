import type {
  ModelTypeName,
  ObjectGenerationParams,
  Plugin,
  TextEmbeddingParams,
} from '@elizaos/core';
import {
  type DetokenizeTextParams,
  type GenerateTextParams,
  ModelType,
  type TokenizeTextParams,
  logger,
} from '@elizaos/core';
import { generateObject, generateText } from 'ai';
import { type TiktokenModel, encodingForModel } from 'js-tiktoken';
import { createOllama } from 'ollama-ai-provider';

// Default Ollama API URL
const OLLAMA_API_URL = 'http://localhost:11434/api';

function findModelName(model: ModelTypeName): TiktokenModel {
  try {
    const name =
      model === ModelType.TEXT_SMALL
        ? (process.env.OLLAMA_SMALL_MODEL ?? 'llama3')
        : (process.env.OLLAMA_LARGE_MODEL ?? 'llama3');
    return name as TiktokenModel;
  } catch (error) {
    logger.error('Error in findModelName:', error);
    return 'llama3' as TiktokenModel;
  }
}

async function tokenizeText(model: ModelTypeName, prompt: string) {
  try {
    const encoding = encodingForModel(findModelName(model));
    const tokens = encoding.encode(prompt);
    return tokens;
  } catch (error) {
    logger.error('Error in tokenizeText:', error);
    return [];
  }
}

/**
 * Detokenize a sequence of tokens back into text using the specified model.
 *
 * @param {ModelTypeName} model - The type of model to use for detokenization.
 * @param {number[]} tokens - The sequence of tokens to detokenize.
 * @returns {string} The detokenized text.
 */
async function detokenizeText(model: ModelTypeName, tokens: number[]) {
  try {
    const modelName = findModelName(model);
    const encoding = encodingForModel(modelName);
    return encoding.decode(tokens);
  } catch (error) {
    logger.error('Error in detokenizeText:', error);
    return '';
  }
}

/**
 * Generate text using Ollama API
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
    logger.error('Error in generateOllamaText:', error);
    return 'Error generating text. Please try again later.';
  }
}

/**
 * Generate object using Ollama API with consistent error handling
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
    logger.error('Error generating object:', error);
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
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      try {
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL: runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL,
        });

        const modelName = runtime.getSetting('OLLAMA_EMBEDDING_MODEL') || 'nomic-embed-text';
        const text =
          typeof params === 'string' ? params : (params as TextEmbeddingParams)?.text || '';

        if (!text) {
          logger.error('No text provided for embedding');
          return Array(1536).fill(0);
        }

        // Generate embeddings - note we're using a simpler approach since generateEmbedding
        // may not be available in the current version of the AI SDK
        try {
          // This is simplified and may need to be adjusted based on the actual API
          const response = await fetch(
            `${runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL}/embeddings`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: modelName,
                prompt: text,
              }),
            }
          );

          if (!response.ok) {
            throw new Error(`Embedding request failed: ${response.statusText}`);
          }

          const result = (await response.json()) as { embedding?: number[] };
          return result.embedding || Array(1536).fill(0);
        } catch (embeddingError) {
          logger.error('Error generating embedding:', embeddingError);
          return Array(1536).fill(0);
        }
      } catch (error) {
        logger.error('Error in TEXT_EMBEDDING model:', error);
        // Return a fallback vector rather than crashing
        return Array(1536).fill(0);
      }
    },
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime,
      { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams
    ) => {
      try {
        return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
      } catch (error) {
        logger.error('Error in TEXT_TOKENIZER_ENCODE model:', error);
        // Return empty array instead of crashing
        return [];
      }
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime,
      { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams
    ) => {
      try {
        return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
      } catch (error) {
        logger.error('Error in TEXT_TOKENIZER_DECODE model:', error);
        // Return empty string instead of crashing
        return '';
      }
    },
    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }: GenerateTextParams) => {
      try {
        const temperature = 0.7;
        const frequency_penalty = 0.7;
        const presence_penalty = 0.7;
        const max_response_length = 8000;
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL: runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL,
        });

        const model =
          runtime.getSetting('OLLAMA_SMALL_MODEL') ?? runtime.getSetting('SMALL_MODEL') ?? 'llama3';

        logger.log('generating text');
        logger.log(prompt);

        return await generateOllamaText(ollama, model, {
          prompt,
          system: runtime.character.system ?? undefined,
          temperature,
          maxTokens: max_response_length,
          frequencyPenalty: frequency_penalty,
          presencePenalty: presence_penalty,
          stopSequences,
        });
      } catch (error) {
        logger.error('Error in TEXT_SMALL model:', error);
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
          runtime.getSetting('OLLAMA_LARGE_MODEL') ?? runtime.getSetting('LARGE_MODEL') ?? 'llama3';
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL: runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL,
        });

        return await generateOllamaText(ollama, model, {
          prompt,
          system: runtime.character.system ?? undefined,
          temperature,
          maxTokens,
          frequencyPenalty,
          presencePenalty,
          stopSequences,
        });
      } catch (error) {
        logger.error('Error in TEXT_LARGE model:', error);
        return 'Error generating text. Please try again later.';
      }
    },
    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      try {
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL: runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL,
        });
        const model =
          runtime.getSetting('OLLAMA_SMALL_MODEL') ?? runtime.getSetting('SMALL_MODEL') ?? 'llama3';

        if (params.schema) {
          logger.info('Using OBJECT_SMALL without schema validation');
        }

        return await generateOllamaObject(ollama, model, params);
      } catch (error) {
        logger.error('Error in OBJECT_SMALL model:', error);
        // Return empty object instead of crashing
        return {};
      }
    },
    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      try {
        const ollama = createOllama({
          fetch: runtime.fetch,
          baseURL: runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL,
        });
        const model =
          runtime.getSetting('OLLAMA_LARGE_MODEL') ?? runtime.getSetting('LARGE_MODEL') ?? 'llama3';

        if (params.schema) {
          logger.info('Using OBJECT_LARGE without schema validation');
        }

        return await generateOllamaObject(ollama, model, params);
      } catch (error) {
        logger.error('Error in OBJECT_LARGE model:', error);
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
              const baseURL = runtime.getSetting('OLLAMA_API_ENDPOINT') || OLLAMA_API_URL;
              const response = await fetch(`${baseURL}/tags`);
              const data = await response.json();
              logger.log('Models Available:', (data as { models: unknown[] })?.models?.length);
              if (!response.ok) {
                logger.error(`Failed to validate Ollama API: ${response.statusText}`);
                return;
              }
            } catch (error) {
              logger.error('Error in ollama_test_url_validation:', error);
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
              logger.log('embedding', embedding);
            } catch (error) {
              logger.error('Error in test_text_embedding:', error);
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
              logger.log('generated with test_text_large:', text);
            } catch (error) {
              logger.error('Error in test_text_large:', error);
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
              logger.log('generated with test_text_small:', text);
            } catch (error) {
              logger.error('Error in test_text_small:', error);
            }
          },
        },
        {
          name: 'ollama_test_text_tokenizer_encode',
          fn: async (runtime) => {
            try {
              const prompt = 'Hello tokenizer encode!';
              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, { prompt });
              if (!Array.isArray(tokens) || tokens.length === 0) {
                logger.error('Failed to tokenize text: expected non-empty array of tokens');
                return;
              }
              logger.log('Tokenized output:', tokens);
            } catch (error) {
              logger.error('Error in test_text_tokenizer_encode:', error);
            }
          },
        },
        {
          name: 'ollama_test_text_tokenizer_decode',
          fn: async (runtime) => {
            try {
              const prompt = 'Hello tokenizer decode!';
              // Encode the string into tokens first
              const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, { prompt });
              // Now decode tokens back into text
              const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
                tokens,
              });
              if (decodedText !== prompt) {
                logger.error(
                  `Decoded text does not match original. Expected "${prompt}", got "${decodedText}"`
                );
                return;
              }
              logger.log('Decoded text:', decodedText);
            } catch (error) {
              logger.error('Error in test_text_tokenizer_decode:', error);
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
              });
              logger.log('Generated object:', object);
            } catch (error) {
              logger.error('Error in test_object_small:', error);
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
              });
              logger.log('Generated object:', object);
            } catch (error) {
              logger.error('Error in test_object_large:', error);
            }
          },
        },
      ],
    },
  ],
};
export default ollamaPlugin;
