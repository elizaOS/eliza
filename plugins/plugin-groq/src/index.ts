import { createGroq } from '@ai-sdk/groq';
import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams, Plugin } from '@elizaos/core';
import {
  type DetokenizeTextParams,
  type GenerateTextParams,
  ModelType,
  ServiceType,
  type TokenizeTextParams,
  type InstrumentationService,
  logger,
} from '@elizaos/core';
import { generateObject, generateText } from 'ai';
import { type TiktokenModel, encodingForModel } from 'js-tiktoken';
import { context, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * Retrieves the Groq API base URL, using runtime settings or environment variables if available.
 *
 * @returns The resolved Groq API base URL.
 */
function getBaseURL(runtime: any): string {
  return runtime.getSetting('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1';
}

/**
 * Returns the appropriate Groq model name string for the specified model type.
 *
 * If environment variables for model names are set, they are used; otherwise, defaults are returned.
 *
 * @param model - The model type for which to retrieve the model name.
 * @returns The model name string corresponding to the given {@link model}.
 *
 * @remark If an error occurs, returns the default model name 'llama-3.1-8b-instant'.
 */
function findModelName(runtime: IAgentRuntime, model: ModelTypeName): TiktokenModel {
  try {
    const name =
      model === ModelType.TEXT_SMALL
        ? (runtime.getSetting('GROQ_SMALL_MODEL') ?? 'llama-3.1-8b-instant')
        : (runtime.getSetting('GROQ_LARGE_MODEL') ?? 'qwen-qwq-32b');
    return name as TiktokenModel;
  } catch (error) {
    logger.error('Error in findModelName:', error);
    return 'llama-3.1-8b-instant' as TiktokenModel;
  }
}

async function tokenizeText(runtime: IAgentRuntime, model: ModelTypeName, prompt: string) {
  try {
    const encoding = encodingForModel(findModelName(runtime, model));
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
async function detokenizeText(runtime: IAgentRuntime, model: ModelTypeName, tokens: number[]) {
  try {
    const modelName = findModelName(runtime, model);
    const encoding = encodingForModel(modelName);
    return encoding.decode(tokens);
  } catch (error) {
    logger.error('Error in detokenizeText:', error);
    return '';
  }
}

/**
 * Handles rate limit errors, waits for the appropriate delay, and retries the operation
 * @param error The error object from the failed request
 * @param retryFn The function to retry after waiting
 * @returns Result from the retry function
 */
async function handleRateLimitError(error: Error, retryFn: () => Promise<unknown>) {
  try {
    if (error.message.includes('Rate limit reached')) {
      logger.warn('Groq rate limit reached', { error: error.message });

      // Extract retry delay from error message if possible
      let retryDelay = 10000; // Default to 10 seconds
      const delayMatch = error.message.match(/try again in (\d+\.?\d*)s/i);
      if (delayMatch?.[1]) {
        // Convert to milliseconds and add a small buffer
        retryDelay = Math.ceil(Number.parseFloat(delayMatch[1]) * 1000) + 1000;
      }

      logger.info(`Will retry after ${retryDelay}ms delay`);

      // Wait for the suggested delay plus a small buffer
      await new Promise((resolve) => setTimeout(resolve, retryDelay));

      // Retry the request
      logger.info('Retrying request after rate limit delay');
      return await retryFn();
    }

    // For other errors, log and rethrow
    logger.error('Error with Groq API:', error);
    throw error;
  } catch (retryError) {
    logger.error('Error during retry handling:', retryError);
    throw retryError;
  }
}

/**
 * Helper function to get tracer if instrumentation is enabled
 */
function getTracer(runtime: IAgentRuntime) {
  const availableServices = Array.from(runtime.getAllServices().keys());
  logger.debug(`[getTracer] Available services: ${JSON.stringify(availableServices)}`);
  logger.debug(`[getTracer] Attempting to get service with key: ${ServiceType.INSTRUMENTATION}`);

  const instrumentationService = runtime.getService<InstrumentationService>(
    ServiceType.INSTRUMENTATION
  );

  if (!instrumentationService) {
    logger.warn(`[getTracer] Service ${ServiceType.INSTRUMENTATION} not found in runtime.`);
    return null;
  }

  if (!instrumentationService.isEnabled()) {
    logger.debug('[getTracer] Instrumentation service found but is disabled.');
    return null;
  }

  logger.debug('[getTracer] Successfully retrieved enabled instrumentation service.');
  return instrumentationService.getTracer('eliza.llm.openai');
}

/**
 * Helper function to start an LLM span
 */
async function startLlmSpan<T>(
  runtime: IAgentRuntime,
  spanName: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer(runtime);
  if (!tracer) {
    const dummySpan = {
      setAttribute: () => {},
      setAttributes: () => {},
      addEvent: () => {},
      recordException: () => {},
      setStatus: () => {},
      end: () => {},
      spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
    } as unknown as Span;
    return fn(dummySpan);
  }

  // Get active context to ensure proper nesting
  const activeContext = context.active();

  return tracer.startActiveSpan(spanName, { attributes }, activeContext, async (span: Span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.end();
      throw error;
    }
  });
}


/**
 * Generate text using Groq API with retry handling for rate limits
 */
async function generateGroqText(
  groq: ReturnType<typeof createGroq>,
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
    const { text: groqResponse } = await generateText({
      model: groq.languageModel(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences,
    });
    return groqResponse;
  } catch (error: unknown) {
    try {
      return await handleRateLimitError(error as Error, async () => {
        const { text: groqRetryResponse } = await generateText({
          model: groq.languageModel(model),
          prompt: params.prompt,
          system: params.system,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          frequencyPenalty: params.frequencyPenalty,
          presencePenalty: params.presencePenalty,
          stopSequences: params.stopSequences,
        });
        return groqRetryResponse;
      });
    } catch (retryError) {
      logger.error('Final error in generateGroqText:', retryError);
      return 'Error generating text. Please try again later.';
    }
  }
}

/**
 * Generate object using Groq API with consistent error handling
 */
async function generateGroqObject(
  groq: ReturnType<typeof createGroq>,
  model: string,
  params: ObjectGenerationParams
) {
  try {
    const { object } = await generateObject({
      model: groq.languageModel(model),
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

export const groqPlugin: Plugin = {
  name: 'groq',
  description: 'Groq plugin',
  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    if (!runtime.getSetting('GROQ_API_KEY')) {
      throw Error('Missing GROQ_API_KEY in environment variables');
    }
  },
  models: {
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      runtime,
      { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams
    ) => {
      try {
        return await tokenizeText(runtime, modelType ?? ModelType.TEXT_LARGE, prompt);
      } catch (error) {
        logger.error('Error in TEXT_TOKENIZER_ENCODE model:', error);
        // Return empty array instead of crashing
        return [];
      }
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      runtime,
      { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams
    ) => {
      try {
        return await detokenizeText(runtime, modelType ?? ModelType.TEXT_LARGE, tokens);
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
        const baseURL = getBaseURL(runtime);
        const groq = createGroq({
          apiKey: runtime.getSetting('GROQ_API_KEY'),
          fetch: runtime.fetch,
          baseURL,
        });

        const model =
          runtime.getSetting('GROQ_SMALL_MODEL') ??
          runtime.getSetting('SMALL_MODEL') ??
          'llama-3.1-8b-instant';

        logger.log('generating text');
        logger.log(prompt);

        return await generateGroqText(groq, model, {
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
          runtime.getSetting('GROQ_LARGE_MODEL') ??
          runtime.getSetting('LARGE_MODEL') ??
          'qwen-qwq-32b';
        const baseURL = getBaseURL(runtime);
        const groq = createGroq({
          apiKey: runtime.getSetting('GROQ_API_KEY'),
          fetch: runtime.fetch,
          baseURL,
        });

        return await generateGroqText(groq, model, {
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
    [ModelType.IMAGE]: async (
      runtime,
      params: {
        prompt: string;
        n?: number;
        size?: string;
      }
    ) => {
      try {
        const baseURL = getBaseURL(runtime);
        const response = await fetch(`${baseURL}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: params.prompt,
            n: params.n || 1,
            size: params.size || '1024x1024',
          }),
        });
        if (!response.ok) {
          logger.error(`Failed to generate image: ${response.statusText}`);
          return [{ url: '' }];
        }
        const data = await response.json();
        const typedData = data as { data: { url: string }[] };
        return typedData.data;
      } catch (error) {
        logger.error('Error in IMAGE model:', error);
        return [{ url: '' }];
      }
    },
    [ModelType.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
      try {
        const baseURL = getBaseURL(runtime);

        // Create a FormData instance
        const formData = new FormData();
        const file = new File([audioBuffer], 'audio.mp3', { type: 'audio/mp3' });
        formData.append('file', file);
        formData.append('model', 'distil-whisper-large-v3-en');

        const response = await fetch(`${baseURL}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}`,
          },
          body: formData,
        });

        if (!response.ok) {
          logger.error(`Failed to transcribe audio: ${response.statusText}`);
          return 'Error transcribing audio. Please try again later.';
        }
        const data = (await response.json()) as { text: string };
        return data.text;
      } catch (error) {
        //console.error('groq audio', error)
        logger.error('Error in TRANSCRIPTION model:', error);
        return 'Error transcribing audio. Please try again later.';
      }
    },
    // you can include elevenlabs before this plugin to prefer elevenlabs voice
    // The model playai-tts requires terms acceptance. Please have the org admin accept the terms at https://console.groq.com/playground?model=playai-tts"
    [ModelType.TEXT_TO_SPEECH]: async (runtime: IAgentRuntime, text: string) => {
      const ttsModelName = runtime.getSetting('GROQ_TTS_MODEL') || 'playai-tts';
      const voice = runtime.getSetting('GROQ_TTS_VOICE') || 'Chip-PlayAI';
      const attributes = {
        'llm.vendor': 'Groq',
        'llm.request.type': 'tts',
        'llm.request.model': ttsModelName,
        'input.text.length': text.length,
      };
      return startLlmSpan(runtime, 'LLM.tts', attributes, async (span) => {
        logger.log(`[Groq] Using TEXT_TO_SPEECH model: ${ttsModelName}`);
        span.addEvent('llm.prompt', { 'prompt.content': text });
        try {
          const baseURL = getBaseURL(runtime);
          const res = await fetch(`${baseURL}/audio/speech`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: ttsModelName,
              voice,
              input: text,
              //...(instructions && { instructions }),
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new Error(`Groq TTS error ${res.status}: ${err}`);
          }

          const speechStream = res.body;
          //const speechStream = await fetchTextToSpeech(runtime, text);
          span.addEvent('llm.response.success', {
            info: 'Speech stream generated',
          });
          return speechStream;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          const exception = error instanceof Error ? error : new Error(message);
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR, message: message });
          throw error;
        }
      });
    },
    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      try {
        const baseURL = getBaseURL(runtime);
        const groq = createGroq({
          apiKey: runtime.getSetting('GROQ_API_KEY'),
          baseURL,
        });
        const model =
          runtime.getSetting('GROQ_SMALL_MODEL') ??
          runtime.getSetting('SMALL_MODEL') ??
          'llama-3.1-8b-instant';

        if (params.schema) {
          logger.info('Using OBJECT_SMALL without schema validation');
        }

        return await generateGroqObject(groq, model, params);
      } catch (error) {
        logger.error('Error in OBJECT_SMALL model:', error);
        // Return empty object instead of crashing
        return {};
      }
    },
    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      try {
        const baseURL = getBaseURL(runtime);
        const groq = createGroq({
          apiKey: runtime.getSetting('GROQ_API_KEY'),
          baseURL,
        });
        const model =
          runtime.getSetting('GROQ_LARGE_MODEL') ??
          runtime.getSetting('LARGE_MODEL') ??
          'qwen-qwq-32b';

        if (params.schema) {
          logger.info('Using OBJECT_LARGE without schema validation');
        }

        return await generateGroqObject(groq, model, params);
      } catch (error) {
        logger.error('Error in OBJECT_LARGE model:', error);
        // Return empty object instead of crashing
        return {};
      }
    },
  },
  tests: [
    {
      name: 'groq_plugin_tests',
      tests: [
        {
          name: 'groq_test_url_and_api_key_validation',
          fn: async (runtime) => {
            try {
              const baseURL = getBaseURL(runtime) ?? 'https://api.groq.com/openai/v1';
              const response = await fetch(`${baseURL}/models`, {
                headers: {
                  Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}`,
                },
              });
              const data = await response.json();
              logger.log('Models Available:', (data as { data: unknown[] })?.data?.length);
              if (!response.ok) {
                logger.error(`Failed to validate Groq API key: ${response.statusText}`);
                return;
              }
            } catch (error) {
              logger.error('Error in groq_test_url_and_api_key_validation:', error);
            }
          },
        },
        {
          name: 'groq_test_text_large',
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
          name: 'groq_test_text_small',
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
          name: 'groq_test_image_generation',
          fn: async (runtime) => {
            try {
              logger.log('groq_test_image_generation');
              const image = await runtime.useModel(ModelType.IMAGE, {
                prompt: 'A beautiful sunset over a calm ocean',
                n: 1,
                size: '1024x1024',
              });
              logger.log('generated with test_image_generation:', image);
            } catch (error) {
              logger.error('Error in test_image_generation:', error);
            }
          },
        },
        {
          name: 'groq_test_transcription',
          fn: async (runtime) => {
            try {
              logger.log('groq_test_transcription');
              const response = await fetch(
                'https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg'
              );
              if (!response.ok) {
                logger.error(`Failed to fetch audio sample: ${response.statusText}`);
                return;
              }
              const arrayBuffer = await response.arrayBuffer();
              const transcription = await runtime.useModel(
                ModelType.TRANSCRIPTION,
                Buffer.from(new Uint8Array(arrayBuffer))
              );
              logger.log('generated with test_transcription:', transcription);
            } catch (error) {
              logger.error('Error in test_transcription:', error);
            }
          },
        },
        {
          name: 'groq_test_text_tokenizer_encode',
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
          name: 'groq_test_text_tokenizer_decode',
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
          name: 'groq_test_object_small',
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
          name: 'groq_test_object_large',
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
export default groqPlugin;
