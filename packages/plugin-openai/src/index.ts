import { createOpenAI } from '@ai-sdk/openai';
import type {
  IAgentRuntime,
  IInstrumentationService,
  ImageDescriptionParams,
  ModelTypeName,
  ObjectGenerationParams,
  Plugin,
  ServiceTypeName,
  TextEmbeddingParams,
  TokenizeTextParams,
  DetokenizeTextParams,
  GenerateTextParams,
} from '@elizaos/core';
import {
  ModelType,
  logger,
  VECTOR_DIMS,
  safeReplacer,
  type InstrumentationService,
  ServiceType,
} from '@elizaos/core';
import { generateObject, generateText, JSONParseError, type JSONValue } from 'ai';
import { type TiktokenModel, encodingForModel } from 'js-tiktoken';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { SpanStatusCode, trace, type Span, context } from '@opentelemetry/api';

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
    logger.debug(`[getTracer] Instrumentation service found but is disabled.`);
    return null;
  }

  logger.debug(`[getTracer] Successfully retrieved enabled instrumentation service.`);
  return instrumentationService.getTracer('eliza.llm.openai');
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
    // If tracing disabled, execute function directly
    // Create a dummy span object with no-op methods
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
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: IAgentRuntime) => string
): Promise<JSONValue> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);
  const temperature = params.temperature ?? 0;
  const schemaPresent = !!params.schema;

  // --- Start Instrumentation ---
  const attributes = {
    'llm.vendor': 'OpenAI',
    'llm.request.type': 'object_generation',
    'llm.request.model': modelName,
    'llm.request.temperature': temperature,
    'llm.request.schema_present': schemaPresent,
  };

  return startLlmSpan(runtime, 'LLM.generateObject', attributes, async (span) => {
    span.addEvent('llm.prompt', { 'prompt.content': params.prompt });
    if (schemaPresent) {
      span.addEvent('llm.request.schema', {
        schema: JSON.stringify(params.schema, safeReplacer()),
      });
    }

    try {
      const result = await generateObject({
        model: openai.languageModel(modelName),
        output: 'no-schema',
        prompt: params.prompt,
        temperature: temperature,
      });

      const processedObject = result.object;
      span.addEvent('llm.response.processed', {
        'response.object': JSON.stringify(processedObject, safeReplacer()),
      });

      if (result.usage) {
        span.setAttributes({
          'llm.usage.prompt_tokens': result.usage.promptTokens,
          'llm.usage.completion_tokens': result.usage.completionTokens,
          'llm.usage.total_tokens': result.usage.totalTokens,
        });
      }
      span.addEvent('llm.response.raw', {
        raw: JSON.stringify(result.rawResponse, safeReplacer()),
      });
      return processedObject;
    } catch (error: any) {
      if (error instanceof JSONParseError) {
        logger.error(`[generateObject] Failed to parse JSON: ${error.message}`);
        span.recordException(error);
        span.addEvent('llm.error.json_parse', {
          'error.message': error.message,
          'error.text': error.text,
        });

        // Attempt to repair JSON using a secondary LLM call
        span.addEvent('llm.repair.attempt');
        const repairFunction = getJsonRepairFunction();
        const repairedJsonString = await repairFunction({
          text: error.text,
          error,
        });

        if (repairedJsonString) {
          try {
            const repairedObject = JSON.parse(repairedJsonString);
            span.addEvent('llm.repair.success', {
              repaired_object: JSON.stringify(repairedObject, safeReplacer()),
            });
            logger.info('[generateObject] Successfully repaired JSON.');
            // Consider setting OK status if repair successful? Or keep ERROR but add event?
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'JSON parsing failed but was repaired',
            });
            return repairedObject;
          } catch (repairParseError: any) {
            logger.error(
              `[generateObject] Failed to parse repaired JSON: ${repairParseError.message}`
            );
            span.recordException(repairParseError);
            span.addEvent('llm.repair.parse_error', {
              'error.message': repairParseError.message,
            });
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `JSON repair failed: ${repairParseError.message}`,
            });
            throw repairParseError; // Throw the repair error
          }
        } else {
          logger.error('[generateObject] JSON repair failed.');
          span.addEvent('llm.repair.failed');
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `JSON repair failed: ${error.message}`,
          });
          throw error; // Throw original error if repair fails
        }
      } else {
        logger.error(`[generateObject] Unknown error: ${error.message}`);
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        throw error; // Rethrow other errors
      }
    }
  });
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
      return null;
    } catch (e) {
      logger.error(`[getJsonRepairFunction] Failed to repair JSON: ${e}`);
      return null;
    }
  };
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
          logger.log('OpenAI API key validated successfully');
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
      const embeddingModelName = getSetting(
        runtime,
        'OPENAI_EMBEDDING_MODEL',
        'text-embedding-3-small'
      );
      const embeddingDimension = Number.parseInt(
        getSetting(runtime, 'OPENAI_EMBEDDING_DIMENSIONS', '1536')
      ) as (typeof VECTOR_DIMS)[keyof typeof VECTOR_DIMS];

      // Validate embedding dimension
      if (!Object.values(VECTOR_DIMS).includes(embeddingDimension)) {
        logger.error(
          `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(', ')}`
        );
        // No span needed here as it's a config error before API call
        throw new Error(
          `Invalid embedding dimension: ${embeddingDimension}. Must be one of: ${Object.values(VECTOR_DIMS).join(', ')}`
        );
      }

      // Handle null input (initialization case)
      if (params === null) {
        logger.debug('Creating test embedding for initialization');
        const testVector = Array(embeddingDimension).fill(0);
        testVector[0] = 0.1; // Make it non-zero
        // No span needed for initialization
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
        const fallbackVector = Array(embeddingDimension).fill(0);
        fallbackVector[0] = 0.2; // Different value for tracking
        // No span needed for invalid input
        return fallbackVector;
      }

      // Skip API call for empty text
      if (!text.trim()) {
        logger.warn('Empty text for embedding');
        const emptyVector = Array(embeddingDimension).fill(0);
        emptyVector[0] = 0.3; // Different value for tracking
        // No span needed for empty input
        return emptyVector;
      }

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'OpenAI',
        'llm.request.type': 'embedding',
        'llm.request.model': embeddingModelName,
        'llm.request.embedding.dimensions': embeddingDimension,
        'input.text.length': text.length, // Add input text length
      };

      return startLlmSpan(runtime, 'LLM.embedding', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': text });

        const baseURL = getBaseURL(runtime);
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'OpenAI API key not configured' });
          throw new Error('OpenAI API key not configured');
        }

        // Call the OpenAI API
        const response = await fetch(`${baseURL}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: embeddingModelName,
            input: text,
            dimensions: embeddingDimension, // Pass dimension to API if supported by model
          }),
        });

        // Clone the response to read the body multiple times
        const responseClone = response.clone();
        const rawResponseBody = await responseClone.text();
        span.addEvent('llm.response.raw', { 'response.body': rawResponseBody });

        if (!response.ok) {
          span.setAttributes({ 'error.api.status': response.status });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `OpenAI API error: ${response.status} - ${response.statusText}. Response: ${rawResponseBody}`,
          });
          logger.error(
            `OpenAI API error: ${response.status} - ${response.statusText}. Raw Response: ${rawResponseBody}`
          );
          // Return error vector but ensure span status is ERROR
          const errorVector = Array(embeddingDimension).fill(0);
          errorVector[0] = 0.4; // Different value for tracking
          return errorVector;
        }

        const data = (await response.json()) as {
          data: [{ embedding: number[] }];
          usage?: { prompt_tokens: number; total_tokens: number }; // Add optional usage
        };

        if (!data?.data?.[0]?.embedding) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'API returned invalid structure' });
          logger.error('API returned invalid structure');
          const errorVector = Array(embeddingDimension).fill(0);
          errorVector[0] = 0.5; // Different value for tracking
          return errorVector;
        }

        const embedding = data.data[0].embedding;
        span.setAttribute('llm.response.embedding.vector_length', embedding.length);
        // Log processed response (optional, could be large)
        // span.addEvent('llm.response.processed', { 'response.embedding': JSON.stringify(embedding.slice(0, 10)) + '...' });

        // Log usage if available
        if (data.usage) {
          span.setAttributes({
            'llm.usage.prompt_tokens': data.usage.prompt_tokens,
            'llm.usage.total_tokens': data.usage.total_tokens,
          });
        }

        logger.log(`Got valid embedding with length ${embedding.length}`);
        return embedding;
      });
      // --- End Instrumentation ---
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
      const modelName = getSmallModel(runtime);

      logger.log('generating text with small model');
      logger.log(prompt);

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'OpenAI',
        'llm.request.type': 'completion',
        'llm.request.model': modelName,
        'llm.request.temperature': temperature,
        'llm.request.max_tokens': max_response_length,
        'llm.request.frequency_penalty': frequency_penalty,
        'llm.request.presence_penalty': presence_penalty,
        'llm.request.stop_sequences': JSON.stringify(stopSequences),
      };

      return startLlmSpan(runtime, 'LLM.generateText', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': prompt });

        const result = await generateText({
          model: openai.languageModel(modelName),
          prompt: prompt,
          system: runtime.character.system ?? undefined,
          temperature: temperature,
          maxTokens: max_response_length,
          frequencyPenalty: frequency_penalty,
          presencePenalty: presence_penalty,
          stopSequences: stopSequences,
        });

        const processedTextResponse = result.text;
        span.setAttribute('llm.response.processed.length', processedTextResponse.length);
        span.addEvent('llm.response.processed', {
          'response.content':
            processedTextResponse.substring(0, 200) +
            (processedTextResponse.length > 200 ? '...' : ''),
        });

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
      });
      // --- End Instrumentation ---
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
      const modelName = getLargeModel(runtime);

      logger.log('generating text with large model');
      logger.log(prompt);

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'OpenAI',
        'llm.request.type': 'completion',
        'llm.request.model': modelName,
        'llm.request.temperature': temperature,
        'llm.request.max_tokens': maxTokens,
        'llm.request.frequency_penalty': frequencyPenalty,
        'llm.request.presence_penalty': presencePenalty,
        'llm.request.stop_sequences': JSON.stringify(stopSequences),
      };

      return startLlmSpan(runtime, 'LLM.generateText', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': prompt });

        const result = await generateText({
          model: openai.languageModel(modelName),
          prompt: prompt,
          system: runtime.character.system ?? undefined,
          temperature: temperature,
          maxTokens: maxTokens,
          frequencyPenalty: frequencyPenalty,
          presencePenalty: presencePenalty,
          stopSequences: stopSequences,
        });

        const processedTextResponse = result.text;
        span.setAttribute('llm.response.processed.length', processedTextResponse.length);
        span.addEvent('llm.response.processed', {
          'response.content':
            processedTextResponse.substring(0, 200) +
            (processedTextResponse.length > 200 ? '...' : ''),
        });

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
      });
      // --- End Instrumentation ---
    },
    [ModelType.IMAGE]: async (
      runtime,
      params: {
        prompt: string;
        n?: number;
        size?: string;
      }
    ) => {
      const n = params.n || 1;
      const size = params.size || '1024x1024';
      const prompt = params.prompt;

      // --- Start Instrumentation ---
      const attributes = {
        'llm.vendor': 'OpenAI',
        'llm.request.type': 'image_generation',
        // 'llm.request.model': 'dall-e-3', // Or appropriate model if specified/known
        'llm.request.image.size': size,
        'llm.request.image.count': n,
      };

      return startLlmSpan(runtime, 'LLM.imageGeneration', attributes, async (span) => {
        span.addEvent('llm.prompt', { 'prompt.content': prompt });

        const baseURL = getBaseURL(runtime);
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'OpenAI API key not configured' });
          throw new Error('OpenAI API key not configured');
        }

        const response = await fetch(`${baseURL}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: prompt,
            n: n,
            size: size,
          }),
        });

        // Clone response to read multiple times
        const responseClone = response.clone();
        const rawResponseBody = await responseClone.text();
        span.addEvent('llm.response.raw', { 'response.body': rawResponseBody });

        if (!response.ok) {
          span.setAttributes({ 'error.api.status': response.status });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Failed to generate image: ${response.statusText}. Response: ${rawResponseBody}`,
          });
          throw new Error(`Failed to generate image: ${response.statusText}`);
        }

        const data = await response.json();
        const typedData = data as { data: { url: string }[] };

        // Log processed response (array of URLs)
        span.addEvent('llm.response.processed', {
          'response.urls': JSON.stringify(typedData.data),
        });

        return typedData.data;
      });
      // --- End Instrumentation ---
    },
    [ModelType.IMAGE_DESCRIPTION]: async (runtime, params: ImageDescriptionParams | string) => {
      // Handle string case (direct URL)
      let imageUrl: string;
      let promptText: string | undefined;
      const modelName = 'gpt-4-vision-preview'; // Specific model for this task
      const maxTokens = 300;

      if (typeof params === 'string') {
        imageUrl = params;
        promptText = 'Please analyze this image and provide a title and detailed description.'; // Default prompt
      } else {
        // Object parameter case
        imageUrl = params.imageUrl;
        promptText =
          params.prompt ||
          'Please analyze this image and provide a title and detailed description.'; // Use provided or default prompt
      }

      // --- Start Instrumentation ---
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ];

      const attributes = {
        'llm.vendor': 'OpenAI',
        'llm.request.type': 'chat',
        'llm.request.model': modelName,
        'llm.request.max_tokens': maxTokens,
        'llm.request.image.url': imageUrl, // Log image url
      };

      return startLlmSpan(runtime, 'LLM.imageDescription', attributes, async (span) => {
        // Log messages array as prompt content
        span.addEvent('llm.prompt', { 'prompt.content': JSON.stringify(messages, safeReplacer()) });

        const baseURL = getBaseURL(runtime);
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'OpenAI API key not configured' });
          // Return error structure, but throw error to be caught by startLlmSpan
          throw new Error('OpenAI API key not configured');
        }

        // Call the GPT-4 Vision API
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: messages,
            max_tokens: maxTokens,
          }),
        });

        // Clone response to read multiple times
        const responseClone = response.clone();
        const rawResponseBody = await responseClone.text();
        span.addEvent('llm.response.raw', { 'response.body': rawResponseBody });

        if (!response.ok) {
          span.setAttributes({ 'error.api.status': response.status });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `OpenAI API error: ${response.status}. Response: ${rawResponseBody}`,
          });
          throw new Error(`OpenAI API error: ${response.status}`);
        }

        const result: any = await response.json();
        const content = result.choices?.[0]?.message?.content;

        // Log usage if available
        if (result.usage) {
          span.setAttributes({
            'llm.usage.prompt_tokens': result.usage.prompt_tokens,
            'llm.usage.completion_tokens': result.usage.completion_tokens,
            'llm.usage.total_tokens': result.usage.total_tokens,
          });
        }
        // Log finish reason
        if (result.choices?.[0]?.finish_reason) {
          span.setAttribute('llm.response.finish_reason', result.choices[0].finish_reason);
        }

        if (!content) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'No content in API response' });
          // Return error structure, but throw error to be caught by startLlmSpan
          throw new Error('No content in API response');
        }

        // Extract title and description
        const titleMatch = content.match(/title[:\s]+(.+?)(?:\n|$)/i);
        const title = titleMatch?.[1]?.trim() || 'Image Analysis'; // Added trim()

        // Rest of content is the description
        const description = content.replace(/title[:\s]+(.+?)(?:\n|$)/i, '').trim();

        const processedResult = { title, description };
        span.addEvent('llm.response.processed', {
          'response.object': JSON.stringify(processedResult, safeReplacer()),
        });

        return processedResult;
      });
      // --- End Instrumentation ---
    },
    [ModelType.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
      logger.log('audioBuffer length:', audioBuffer?.length); // Log buffer length

      // --- Start Instrumentation ---
      const modelName = 'whisper-1';
      const attributes = {
        'llm.vendor': 'OpenAI',
        'llm.request.type': 'transcription',
        'llm.request.model': modelName,
        'llm.request.audio.input_size_bytes': audioBuffer?.length || 0,
      };

      return startLlmSpan(runtime, 'LLM.transcription', attributes, async (span) => {
        // Note: Logging full audio buffer as prompt is not practical
        span.addEvent('llm.prompt', { 'prompt.info': 'Audio buffer for transcription' });

        const baseURL = getBaseURL(runtime);
        const apiKey = getApiKey(runtime);

        if (!apiKey) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'OpenAI API key not configured' });
          throw new Error('OpenAI API key not configured');
        }
        if (!audioBuffer || audioBuffer.length === 0) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'Audio buffer is empty or invalid',
          });
          throw new Error('Audio buffer is empty or invalid for transcription');
        }

        const formData = new FormData();
        formData.append('file', audioBuffer, {
          filename: 'recording.mp3', // Assume mp3 for now, might need refinement
          contentType: 'audio/mp3',
        });
        formData.append('model', modelName);

        const response = await fetch(`${baseURL}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            // Content-Type is set automatically by fetch with FormData
          },
          body: formData,
        });

        // Clone response to read multiple times
        const responseClone = response.clone();
        const rawResponseBody = await responseClone.text();
        span.addEvent('llm.response.raw', { 'response.body': rawResponseBody });

        logger.log('transcription response status:', response.status); // Log status

        if (!response.ok) {
          span.setAttributes({ 'error.api.status': response.status });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Failed to transcribe audio: ${response.statusText}. Response: ${rawResponseBody}`,
          });
          throw new Error(`Failed to transcribe audio: ${response.statusText}`);
        }

        const data = (await response.json()) as { text: string };
        const processedText = data.text;

        span.setAttribute('llm.response.processed.length', processedText.length);
        span.addEvent('llm.response.processed', { 'response.text': processedText });

        return processedText;
      });
      // --- End Instrumentation ---
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
      ],
    },
  ],
};
export default openaiPlugin;
