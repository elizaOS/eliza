import { createOpenAI } from '@ai-sdk/openai';
import type {
  AgentRuntime,
  ImageDescriptionParams,
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
  VECTOR_DIMS,
} from '@elizaos/core';
import { generateObject, generateText, JSONParseError, JSONValue } from 'ai';
import { type TiktokenModel, encodingForModel } from 'js-tiktoken';
import FormData from 'form-data';
import fetch from 'node-fetch';

/**
 * Helper function to get settings with fallback to process.env
 *
 * @param runtime The runtime context
 * @param key The setting key to retrieve
 * @param defaultValue Optional default value if not found
 * @returns The setting value with proper fallbacks
 */
function getSetting(runtime: any, key: string, defaultValue?: string): string | undefined {
  return runtime.getSetting(key) ?? process.env[key] ?? defaultValue;
}

/**
 * Helper function to get the base URL for OpenAI API
 *
 * @param runtime The runtime context
 * @returns The configured base URL or default
 */
function getBaseURL(runtime: any): string {
  return getSetting(runtime, 'OPENAI_BASE_URL', 'https://api.openai.com/v1');
}

/**
 * Helper function to get the API key for OpenAI
 *
 * @param runtime The runtime context
 * @returns The configured API key
 */
function getApiKey(runtime: any): string | undefined {
  return getSetting(runtime, 'OPENAI_API_KEY');
}

/**
 * Helper function to get the small model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured small model name
 */
function getSmallModel(runtime: any): string {
  return (
    getSetting(runtime, 'OPENAI_SMALL_MODEL') ?? getSetting(runtime, 'SMALL_MODEL', 'gpt-4o-mini')
  );
}

/**
 * Helper function to get the large model name with fallbacks
 *
 * @param runtime The runtime context
 * @returns The configured large model name
 */
function getLargeModel(runtime: any): string {
  return getSetting(runtime, 'OPENAI_LARGE_MODEL') ?? getSetting(runtime, 'LARGE_MODEL', 'gpt-4o');
}

/**
 * Create an OpenAI client with proper configuration
 *
 * @param runtime The runtime context
 * @returns Configured OpenAI client
 */
function createOpenAIClient(runtime: any) {
  return createOpenAI({
    apiKey: getApiKey(runtime),
    baseURL: getBaseURL(runtime),
  });
}

/**
 * Asynchronously tokenizes the given text based on the specified model and prompt.
 *
 * @param {ModelTypeName} model - The type of model to use for tokenization.
 * @param {string} prompt - The text prompt to tokenize.
 * @returns {number[]} - An array of tokens representing the encoded prompt.
 */
async function tokenizeText(model: ModelTypeName, prompt: string) {
  const modelName =
    model === ModelType.TEXT_SMALL
      ? (process.env.OPENAI_SMALL_MODEL ?? process.env.SMALL_MODEL ?? 'gpt-4o-mini')
      : (process.env.LARGE_MODEL ?? 'gpt-4o');
  const encoding = encodingForModel(modelName as TiktokenModel);
  const tokens = encoding.encode(prompt);
  return tokens;
}

/**
 * Detokenize a sequence of tokens back into text using the specified model.
 *
 * @param {ModelTypeName} model - The type of model to use for detokenization.
 * @param {number[]} tokens - The sequence of tokens to detokenize.
 * @returns {string} The detokenized text.
 */
async function detokenizeText(model: ModelTypeName, tokens: number[]) {
  const modelName =
    model === ModelType.TEXT_SMALL
      ? (process.env.OPENAI_SMALL_MODEL ?? process.env.SMALL_MODEL ?? 'gpt-4o-mini')
      : (process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL ?? 'gpt-4o');
  const encoding = encodingForModel(modelName as TiktokenModel);
  return encoding.decode(tokens);
}

/**
 * Helper function to generate objects using specified model type
 */
async function generateObjectByModelType(
  runtime: AgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: AgentRuntime) => string
): Promise<JSONValue> {
  const openai = createOpenAIClient(runtime);
  const model = getModelFn(runtime);

  try {
    if (params.schema) {
      // Skip zod validation and just use the generateObject without schema
      logger.info(`Using ${modelType} without schema validation`);
    }

    const { object } = await generateObject({
      model: openai.languageModel(model),
      output: 'no-schema',
      prompt: params.prompt,
      temperature: params.temperature,
      experimental_repairText: getJsonRepairFunction(),
    });
    return object;
  } catch (error) {
    logger.error(`Error generating object with ${modelType}:`, error);
    throw error;
  }
}

/**
 * Returns a function to repair JSON text
 */
function getJsonRepairFunction(): (params: {
  text: string;
  error: unknown;
}) => Promise<string | null> {
  return async ({ text, error }: { text: string; error: unknown }) => {
    try {
      if (error instanceof JSONParseError) {
        const cleanedText = text.replace(/```json\n|\n```|```/g, '');

        JSON.parse(cleanedText);
        return cleanedText;
      }
    } catch (jsonError) {
      logger.warn('Failed to repair JSON text:', jsonError);
      return null;
    }
  };
}

/**
 * function for text-to-speech
 */
async function fetchTextToSpeech(runtime: AgentRuntime, text: string) {
  const apiKey = getApiKey(runtime);
  const model = getSetting(runtime, 'OPENAI_TTS_MODEL', 'gpt-4o-mini-tts');
  const voice = getSetting(runtime, 'OPENAI_TTS_VOICE', 'nova');
  const instructions = getSetting(runtime, 'OPENAI_TTS_INSTRUCTIONS', '');
  const baseURL = getBaseURL(runtime);

  try {
    const res = await fetch(`${baseURL}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        ...(instructions && { instructions }),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI TTS error ${res.status}: ${err}`);
    }

    return res.body;
  } catch (err: any) {
    throw new Error(`Failed to fetch speech from OpenAI TTS: ${err.message || err}`);
  }
}

/**
 * Defines the OpenAI plugin with its name, description, and configuration options.
 * @type {Plugin}
 */
export const openaiPlugin: Plugin = {
  name: 'openai',
  description: 'OpenAI plugin',
  config: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
    SMALL_MODEL: process.env.SMALL_MODEL,
    LARGE_MODEL: process.env.LARGE_MODEL,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
    OPENAI_EMBEDDING_DIMENSIONS: process.env.OPENAI_EMBEDDING_DIMENSIONS,
  },
  async init(_config, runtime) {
    try {
      // const validatedConfig = await configSchema.parseAsync(config);

      // // Set all environment variables at once
      // for (const [key, value] of Object.entries(validatedConfig)) {
      // 	if (value) process.env[key] = value;
      // }

      // If API key is not set, we'll show a warning but continue
      if (!getApiKey(runtime)) {
        logger.warn(
          'OPENAI_API_KEY is not set in environment - OpenAI functionality will be limited'
        );
        // Return early without throwing an error
        return;
      }

      // Verify API key only if we have one
      try {
        const baseURL = getBaseURL(runtime);
        const response = await fetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${getApiKey(runtime)}` },
        });

        if (!response.ok) {
          logger.warn(`OpenAI API key validation failed: ${response.statusText}`);
          logger.warn('OpenAI functionality will be limited until a valid API key is provided');
          // Continue execution instead of throwing
        } else {
          // logger.log("OpenAI API key validated successfully");
        }
      } catch (fetchError) {
        logger.warn(`Error validating OpenAI API key: ${fetchError}`);
        logger.warn('OpenAI functionality will be limited until a valid API key is provided');
        // Continue execution instead of throwing
      }
    } catch (error) {
      // Convert to warning instead of error
      logger.warn(
        `OpenAI plugin configuration issue: ${error.errors
          .map((e) => e.message)
          .join(', ')} - You need to configure the OPENAI_API_KEY in your environment variables`
      );
    }
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      const embeddingDimension = parseInt(
        getSetting(runtime, 'OPENAI_EMBEDDING_DIMENSIONS', '1536')
      ) as (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

      // Validate embedding dimension
      if (!Object.values(VECTOR_DIMS).includes(embeddingDimension)) {
        logger.error(
          `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(', ')}`
        );
        throw new Error(
          `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(', ')}`
        );
      }

      // Handle null input (initialization case)
      if (params === null) {
        logger.debug('Creating test embedding for initialization');
        // Return a consistent vector for null input
        const testVector = Array(embeddingDimension).fill(0);
        testVector[0] = 0.1; // Make it non-zero
        return testVector;
      }

      // Get the text from whatever format was provided
      let text: string;
      if (typeof params === 'string') {
        text = params; // Direct string input
      } else if (typeof params === 'object' && params.text) {
        text = params.text; // Object with text property
      } else {
        logger.warn('Invalid input format for embedding');
        // Return a fallback for invalid input
        const fallbackVector = Array(embeddingDimension).fill(0);
        fallbackVector[0] = 0.2; // Different value for tracking
        return fallbackVector;
      }

      // Skip API call for empty text
      if (!text.trim()) {
        logger.warn('Empty text for embedding');
        const emptyVector = Array(embeddingDimension).fill(0);
        emptyVector[0] = 0.3; // Different value for tracking
        return emptyVector;
      }

      try {
        const baseURL = getBaseURL(runtime);

        // Call the OpenAI API
        const response = await fetch(`${baseURL}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${getApiKey(runtime)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: getSetting(runtime, 'OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
            input: text,
          }),
        });

        if (!response.ok) {
          logger.error(`OpenAI API error: ${response.status} - ${response.statusText}`);
          const errorVector = Array(embeddingDimension).fill(0);
          errorVector[0] = 0.4; // Different value for tracking
          return errorVector;
        }

        const data = (await response.json()) as {
          data: [{ embedding: number[] }];
        };

        if (!data?.data?.[0]?.embedding) {
          logger.error('API returned invalid structure');
          const errorVector = Array(embeddingDimension).fill(0);
          errorVector[0] = 0.5; // Different value for tracking
          return errorVector;
        }

        const embedding = data.data[0].embedding;
        logger.log(`Got valid embedding with length ${embedding.length}`);
        return embedding;
      } catch (error) {
        logger.error('Error generating embedding:', error);
        const errorVector = Array(embeddingDimension).fill(0);
        errorVector[0] = 0.6; // Different value for tracking
        return errorVector;
      }
    },
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime,
      { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams
    ) => {
      return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime,
      { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams
    ) => {
      return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
    },
    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }: GenerateTextParams) => {
      const temperature = 0.7;
      const frequency_penalty = 0.7;
      const presence_penalty = 0.7;
      const max_response_length = 8192;

      const openai = createOpenAIClient(runtime);
      const model = getSmallModel(runtime);

      logger.log('generating text');
      logger.log(prompt);

      const { text: openaiResponse } = await generateText({
        model: openai.languageModel(model),
        prompt: prompt,
        system: runtime.character.system ?? undefined,
        temperature: temperature,
        maxTokens: max_response_length,
        frequencyPenalty: frequency_penalty,
        presencePenalty: presence_penalty,
        stopSequences: stopSequences,
      });

      return openaiResponse;
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
      const openai = createOpenAIClient(runtime);
      const model = getLargeModel(runtime);

      const { text: openaiResponse } = await generateText({
        model: openai.languageModel(model),
        prompt: prompt,
        system: runtime.character.system ?? undefined,
        temperature: temperature,
        maxTokens: maxTokens,
        frequencyPenalty: frequencyPenalty,
        presencePenalty: presencePenalty,
        stopSequences: stopSequences,
      });

      return openaiResponse;
    },
    [ModelType.IMAGE]: async (
      runtime,
      params: {
        prompt: string;
        n?: number;
        size?: string;
      }
    ) => {
      const baseURL = getBaseURL(runtime);
      const response = await fetch(`${baseURL}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getApiKey(runtime)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: params.prompt,
          n: params.n || 1,
          size: params.size || '1024x1024',
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to generate image: ${response.statusText}`);
      }
      const data = await response.json();
      const typedData = data as { data: { url: string }[] };
      return typedData.data;
    },
    [ModelType.IMAGE_DESCRIPTION]: async (runtime, params: ImageDescriptionParams | string) => {
      // Handle string case (direct URL)
      let imageUrl: string;
      let prompt: string | undefined;

      if (typeof params === 'string') {
        imageUrl = params;
        prompt = undefined;
      } else {
        // Object parameter case
        imageUrl = params.imageUrl;
        prompt = params.prompt;
      }

      try {
        const baseURL = getBaseURL(runtime);
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          logger.error('OpenAI API key not set');
          return {
            title: 'Failed to analyze image',
            description: 'API key not configured',
          };
        }

        // Call the GPT-4 Vision API
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text:
                      prompt ||
                      'Please analyze this image and provide a title and detailed description.',
                  },
                  {
                    type: 'image_url',
                    image_url: { url: imageUrl },
                  },
                ],
              },
            ],
            max_tokens: 300,
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI API error: ${response.status}`);
        }

        const result: any = await response.json();
        const content = result.choices?.[0]?.message?.content;

        if (!content) {
          return {
            title: 'Failed to analyze image',
            description: 'No response from API',
          };
        }

        // Extract title and description
        const titleMatch = content.match(/title[:\s]+(.+?)(?:\n|$)/i);
        const title = titleMatch?.[1] || 'Image Analysis';

        // Rest of content is the description
        const description = content.replace(/title[:\s]+(.+?)(?:\n|$)/i, '').trim();

        return { title, description };
      } catch (error) {
        logger.error('Error analyzing image:', error);
        return {
          title: 'Failed to analyze image',
          description: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    [ModelType.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
      logger.log('audioBuffer', audioBuffer);
      const baseURL = getBaseURL(runtime);

      const formData = new FormData();
      formData.append('file', audioBuffer, {
        filename: 'recording.mp3',
        contentType: 'audio/mp3',
      });
      formData.append('model', 'whisper-1');

      const response = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getApiKey(runtime)}`,
        },
        body: formData,
      });

      logger.log('response', response);
      if (!response.ok) {
        throw new Error(`Failed to transcribe audio: ${response.statusText}`);
      }

      const data = (await response.json()) as { text: string };
      return data.text;
    },
    [ModelType.TEXT_TO_SPEECH]: async (runtime: AgentRuntime, text: string) => {
      return await fetchTextToSpeech(runtime, text);
    },

    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, getSmallModel);
    },
    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, getLargeModel);
    },
  },
  tests: [
    {
      name: 'openai_plugin_tests',
      tests: [
        {
          name: 'openai_test_url_and_api_key_validation',
          fn: async (runtime) => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: {
                Authorization: `Bearer ${getApiKey(runtime)}`,
              },
            });
            const data = await response.json();
            logger.log('Models Available:', (data as any)?.data.length);
            if (!response.ok) {
              throw new Error(`Failed to validate OpenAI API key: ${response.statusText}`);
            }
          },
        },
        {
          name: 'openai_test_text_embedding',
          fn: async (runtime) => {
            try {
              const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: 'Hello, world!',
              });
              logger.log('embedding', embedding);
            } catch (error) {
              logger.error('Error in test_text_embedding:', error);
              throw error;
            }
          },
        },
        {
          name: 'openai_test_text_large',
          fn: async (runtime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log('generated with test_text_large:', text);
            } catch (error) {
              logger.error('Error in test_text_large:', error);
              throw error;
            }
          },
        },
        {
          name: 'openai_test_text_small',
          fn: async (runtime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log('generated with test_text_small:', text);
            } catch (error) {
              logger.error('Error in test_text_small:', error);
              throw error;
            }
          },
        },
        {
          name: 'openai_test_image_generation',
          fn: async (runtime) => {
            logger.log('openai_test_image_generation');
            try {
              const image = await runtime.useModel(ModelType.IMAGE, {
                prompt: 'A beautiful sunset over a calm ocean',
                n: 1,
                size: '1024x1024',
              });
              logger.log('generated with test_image_generation:', image);
            } catch (error) {
              logger.error('Error in test_image_generation:', error);
              throw error;
            }
          },
        },
        {
          name: 'image-description',
          fn: async (runtime) => {
            try {
              logger.log('openai_test_image_description');
              try {
                const result = await runtime.useModel(
                  ModelType.IMAGE_DESCRIPTION,
                  'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg'
                );

                // Check if result has the expected structure
                if (
                  result &&
                  typeof result === 'object' &&
                  'title' in result &&
                  'description' in result
                ) {
                  logger.log('Image description:', result);
                } else {
                  logger.error('Invalid image description result format:', result);
                }
              } catch (e) {
                logger.error('Error in image description test:', e);
              }
            } catch (e) {
              logger.error('Error in openai_test_image_description:', e);
            }
          },
        },
        {
          name: 'openai_test_transcription',
          fn: async (runtime) => {
            logger.log('openai_test_transcription');
            try {
              const response = await fetch(
                'https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg'
              );
              const arrayBuffer = await response.arrayBuffer();
              const transcription = await runtime.useModel(
                ModelType.TRANSCRIPTION,
                Buffer.from(new Uint8Array(arrayBuffer))
              );
              logger.log('generated with test_transcription:', transcription);
            } catch (error) {
              logger.error('Error in test_transcription:', error);
              throw error;
            }
          },
        },
        {
          name: 'openai_test_text_tokenizer_encode',
          fn: async (runtime) => {
            const prompt = 'Hello tokenizer encode!';
            const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, { prompt });
            if (!Array.isArray(tokens) || tokens.length === 0) {
              throw new Error('Failed to tokenize text: expected non-empty array of tokens');
            }
            logger.log('Tokenized output:', tokens);
          },
        },
        {
          name: 'openai_test_text_tokenizer_decode',
          fn: async (runtime) => {
            const prompt = 'Hello tokenizer decode!';
            // Encode the string into tokens first
            const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, { prompt });
            // Now decode tokens back into text
            const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, { tokens });
            if (decodedText !== prompt) {
              throw new Error(
                `Decoded text does not match original. Expected "${prompt}", got "${decodedText}"`
              );
            }
            logger.log('Decoded text:', decodedText);
          },
        },
        {
          name: 'openai_test_text_to_speech',
          fn: async (runtime: AgentRuntime) => {
            try {
              const text = 'Hello, this is a test for text-to-speech.';
              const response = await fetchTextToSpeech(runtime, text);
              if (!response) {
                throw new Error('Failed to generate speech');
              }
              logger.log('Generated speech successfully');
            } catch (error) {
              logger.error('Error in openai_test_text_to_speech:', error);
              throw error;
            }
          },
        },
      ],
    },
  ],
};
export default openaiPlugin;
