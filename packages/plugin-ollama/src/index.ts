import {
  ModelType,
  type GenerateTextParams,
  type TextEmbeddingParams,
  type ObjectGenerationParams,
  logger,
  safeReplacer,
  ServiceType,
  InstrumentationService,
} from '@elizaos/core';
import type {
  Plugin,
  IAgentRuntime,
  IInstrumentationService,
  ModelTypeName,
} from '@elizaos/core';
import { createOllama } from 'ollama-ai-provider';
import { generateText, generateObject } from 'ai';
import { SpanStatusCode, trace, type Span, context } from '@opentelemetry/api';

/**
 * Helper function to get tracer if instrumentation is enabled
 */
function getTracer(runtime: IAgentRuntime) {
  const instrumentationService = runtime.getService<InstrumentationService>(ServiceType.INSTRUMENTATION);
  if (!instrumentationService?.isEnabled()) {
    return null;
  }
  return instrumentationService.getTracer('eliza.llm.ollama');
}

/**
 * Helper function to start an LLM span
 */
async function startLlmSpan<T>(
  runtime: IAgentRuntime,
  spanName: string,
  attributes: Record<string, any>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer(runtime);
  if (!tracer) {
    const dummySpan = {
      setAttribute: () => { },
      setAttributes: () => { },
      addEvent: () => { },
      recordException: () => { },
      setStatus: () => { },
      end: () => { },
      spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
    } as unknown as Span;
    return fn(dummySpan);
  }

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

// Default Ollama API URL
const OLLAMA_API_URL = 'http://localhost:11434/api';

/**
 * Helper function to get settings with fallback to process.env
 */
function getSetting(runtime: IAgentRuntime, key: string, defaultValue?: string): string | undefined {
  const setting = runtime.getSetting(key);
  if (setting !== null && setting !== undefined) {
    return String(setting);
  }
  return process.env[key] ?? defaultValue;
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

/**
 * Defines the Ollama plugin
 */
export const ollamaPlugin: Plugin = {
  name: 'ollama',
  description: 'Provides integration with Ollama language models',
  config: {
    OLLAMA_API_ENDPOINT: process.env.OLLAMA_API_ENDPOINT,
    OLLAMA_SMALL_MODEL: process.env.OLLAMA_SMALL_MODEL,
    OLLAMA_MEDIUM_MODEL: process.env.OLLAMA_MEDIUM_MODEL,
    OLLAMA_LARGE_MODEL: process.env.OLLAMA_LARGE_MODEL,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL,
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (runtime, params: TextEmbeddingParams | string) => {
      const text = typeof params === 'string' ? params : params.text;
      const modelName = getSetting(runtime, 'OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text');
      const apiUrl = getSetting(runtime, 'OLLAMA_API_URL', OLLAMA_API_URL);

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'Ollama',
        'llm.request.type': 'embedding',
        'llm.request.model': modelName,
        'input.text.length': text?.length || 0,
        'llm.api.base_url': apiUrl,
      };

      return startLlmSpan(runtime, 'LLM.embedding', attributes, async (span) => {
        if (!text || !text.trim()) {
          span.addEvent('llm.prompt', { 'prompt.content': '' });
          logger.warn('[Ollama] Empty text provided for embedding, returning zero vector.');
          span.setStatus({ code: SpanStatusCode.OK, message: 'Empty input, returned zero vector' });
          return Array(768).fill(0);
        }

        span.addEvent('llm.prompt', { 'prompt.content': text });

        try {
          const response = await fetch(`${apiUrl}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: modelName,
              prompt: text,
            }),
          });

          const responseClone = response.clone();
          const rawResponseBody = await responseClone.text();
          span.addEvent('llm.response.raw', { 'response.body': rawResponseBody });

          if (!response.ok) {
            span.setAttributes({ 'error.api.status': response.status });
            throw new Error(
              `[Ollama] Embedding request failed: ${response.status} ${response.statusText}. Response: ${rawResponseBody}`
            );
          }

          const result = (await response.json()) as { embedding?: number[] };

          if (!result.embedding) {
            throw new Error('[Ollama] Invalid response structure: embedding field missing.');
          }

          const embedding = result.embedding;
          span.setAttribute('llm.response.embedding.vector_length', embedding.length);

          return embedding;
        } catch (error) {
          logger.error('[Ollama] Error generating embedding:', error);
          throw error;
        }
      });
      // --- End Instrumentation ---
    },
    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }: GenerateTextParams) => {
      const modelName = getSetting(runtime, 'OLLAMA_SMALL_MODEL', 'llama3:8b');
      const apiUrl = getSetting(runtime, 'OLLAMA_API_URL', OLLAMA_API_URL);
      // Note: Ollama generate endpoint might not support all these params directly via ai-sdk
      const temperature = 0.7;

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'Ollama',
        'llm.request.type': 'completion', // Ollama generally uses completion
        'llm.request.model': modelName,
        'llm.request.temperature': temperature,
        'llm.request.stop_sequences': JSON.stringify(stopSequences),
        'llm.api.base_url': apiUrl,
      };

      return startLlmSpan(runtime, 'LLM.generateText', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': prompt });

        try {
          const ollama = createOllama({
            baseURL: apiUrl,
          });

          // Note: Raw response and detailed usage/finish reason might be abstracted by ai-sdk/provider
          const result = await generateText({
            model: ollama.languageModel(modelName),
            prompt: prompt,
            // Pass other parameters if supported by the provider implementation
            temperature: temperature,
            stopSequences: stopSequences,
            // maxTokens: ... // Add if needed and supported
          });

          const processedTextResponse = result.text;
          span.setAttribute('llm.response.processed.length', processedTextResponse.length);
          span.addEvent('llm.response.processed', { 'response.content': processedTextResponse.substring(0, 200) + (processedTextResponse.length > 200 ? '...' : '') });

          // Log usage if available (often not detailed with Ollama through ai-sdk)
          if (result.usage) {
            span.setAttributes({
              'llm.usage.prompt_tokens': result.usage.promptTokens,
              'llm.usage.completion_tokens': result.usage.completionTokens,
              'llm.usage.total_tokens': result.usage.totalTokens,
            });
          }
          // Log finish reason if available
          if (result.finishReason) {
            span.setAttribute('llm.response.finish_reason', result.finishReason);
          }

          return processedTextResponse;
        } catch (error) {
          logger.error('[Ollama] Error in TEXT_SMALL model:', error);
          throw error;
        }
      });
      // --- End Instrumentation ---
    },
    [ModelType.TEXT_LARGE]: async (
      runtime,
      {
        prompt,
        stopSequences = [],
        maxTokens, // Keep maxTokens if passed in GenerateTextParams
        temperature = 0.7,
        frequencyPenalty, // Ollama might not support these
        presencePenalty, // Ollama might not support these
      }: GenerateTextParams
    ) => {
      const modelName = getSetting(runtime, 'OLLAMA_LARGE_MODEL', 'llama3:70b');
      const apiUrl = getSetting(runtime, 'OLLAMA_API_URL', OLLAMA_API_URL);

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'Ollama',
        'llm.request.type': 'completion',
        'llm.request.model': modelName,
        'llm.request.temperature': temperature,
        'llm.request.max_tokens': maxTokens, // Log if provided
        'llm.request.stop_sequences': JSON.stringify(stopSequences),
        'llm.api.base_url': apiUrl,
        // Log other penalties if they were passed and potentially used
        ...(frequencyPenalty !== undefined && { 'llm.request.frequency_penalty': frequencyPenalty }),
        ...(presencePenalty !== undefined && { 'llm.request.presence_penalty': presencePenalty }),
      };

      return startLlmSpan(runtime, 'LLM.generateText', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': prompt });

        try {
          const ollama = createOllama({
            baseURL: apiUrl,
          });

          const result = await generateText({
            model: ollama.languageModel(modelName),
            prompt: prompt,
            temperature: temperature,
            stopSequences: stopSequences,
            maxTokens: maxTokens, // Pass if defined
            // frequencyPenalty: frequencyPenalty, // Pass if supported by provider
            // presencePenalty: presencePenalty, // Pass if supported by provider
          });

          const processedTextResponse = result.text;
          span.setAttribute('llm.response.processed.length', processedTextResponse.length);
          span.addEvent('llm.response.processed', { 'response.content': processedTextResponse.substring(0, 200) + (processedTextResponse.length > 200 ? '...' : '') });

          if (result.usage) {
            span.setAttributes({
              'llm.usage.prompt_tokens': result.usage.promptTokens,
              'llm.usage.completion_tokens': result.usage.completionTokens,
              'llm.usage.total_tokens': result.usage.totalTokens,
            });
          }
          if (result.finishReason) {
            span.setAttribute('llm.response.finish_reason', result.finishReason);
          }

          return processedTextResponse;
        } catch (error) {
          logger.error('[Ollama] Error in TEXT_LARGE model:', error);
          throw error;
        }
      });
      // --- End Instrumentation ---
    },
    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      const modelName = getSetting(runtime, 'OLLAMA_SMALL_MODEL', 'llama3:8b');
      const apiUrl = getSetting(runtime, 'OLLAMA_API_URL', OLLAMA_API_URL);
      const temperature = params.temperature ?? 0;
      const schemaPresent = !!params.schema;

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'Ollama',
        'llm.request.type': 'object_generation',
        'llm.request.model': modelName,
        'llm.request.temperature': temperature,
        'llm.request.schema_present': schemaPresent,
        'llm.api.base_url': apiUrl,
      };

      return startLlmSpan(runtime, 'LLM.generateObject', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': params.prompt });
        if (schemaPresent) {
          span.addEvent('llm.request.schema', { 'schema': JSON.stringify(params.schema, safeReplacer()) });
        }

        try {
          const ollama = createOllama({
            baseURL: apiUrl,
          });

          // Note: Raw response, usage, finish reason are abstracted by ai-sdk
          const result = await generateObject({
            model: ollama.languageModel(modelName),
            output: 'no-schema', // Explicitly use no-schema for broader compatibility
            prompt: params.prompt,
            temperature: temperature,
          });

          const processedObject = result.object;
          span.addEvent('llm.response.processed', { 'response.object': JSON.stringify(processedObject, safeReplacer()) });

          // Log usage if available
          if (result.usage) {
            span.setAttributes({
              'llm.usage.prompt_tokens': result.usage.promptTokens,
              'llm.usage.completion_tokens': result.usage.completionTokens,
              'llm.usage.total_tokens': result.usage.totalTokens,
            });
          }
          // Log finish reason if available
          if (result.finishReason) {
            span.setAttribute('llm.response.finish_reason', result.finishReason);
          }

          return processedObject;
        } catch (error) {
          logger.error(`[Ollama] Error generating object with ${modelName}:`, error);
          throw error;
        }
      });
      // --- End Instrumentation ---
    },
    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      const modelName = getSetting(runtime, 'OLLAMA_LARGE_MODEL', 'llama3:70b');
      const apiUrl = getSetting(runtime, 'OLLAMA_API_URL', OLLAMA_API_URL);
      const temperature = params.temperature ?? 0;
      const schemaPresent = !!params.schema;

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'Ollama',
        'llm.request.type': 'object_generation',
        'llm.request.model': modelName,
        'llm.request.temperature': temperature,
        'llm.request.schema_present': schemaPresent,
        'llm.api.base_url': apiUrl,
      };

      return startLlmSpan(runtime, 'LLM.generateObject', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': params.prompt });
        if (schemaPresent) {
          span.addEvent('llm.request.schema', { 'schema': JSON.stringify(params.schema, safeReplacer()) });
        }

        try {
          const ollama = createOllama({
            baseURL: apiUrl,
          });

          const result = await generateObject({
            model: ollama.languageModel(modelName),
            output: 'no-schema',
            prompt: params.prompt,
            temperature: temperature,
          });

          const processedObject = result.object;
          span.addEvent('llm.response.processed', { 'response.object': JSON.stringify(processedObject, safeReplacer()) });

          if (result.usage) {
            span.setAttributes({
              'llm.usage.prompt_tokens': result.usage.promptTokens,
              'llm.usage.completion_tokens': result.usage.completionTokens,
              'llm.usage.total_tokens': result.usage.totalTokens,
            });
          }
          if (result.finishReason) {
            span.setAttribute('llm.response.finish_reason', result.finishReason);
          }

          return processedObject;
        } catch (error) {
          logger.error(`[Ollama] Error generating object with ${modelName}:`, error);
          throw error;
        }
      });
      // --- End Instrumentation ---
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
