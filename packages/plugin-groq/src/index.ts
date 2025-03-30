import { createGroq } from '@ai-sdk/groq';
import type {
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
} from '@elizaos/core';
import { generateObject, generateText } from 'ai';
import { type TiktokenModel, encodingForModel } from 'js-tiktoken';
import { z } from 'zod';

/**
 * Runtime interface for the Groq plugin
 */
interface Runtime {
  getSetting(key: string): string | undefined;
  character: {
    system?: string;
  };
  fetch: typeof fetch;
}

/**
 * Gets the Cloudflare Gateway base URL for a specific provider if enabled
 * @param runtime The runtime environment
 * @param provider The model provider name
 * @returns The Cloudflare Gateway base URL if enabled, undefined otherwise
 */
function getCloudflareGatewayBaseURL(runtime: Runtime, provider: string): string | undefined {
  const isCloudflareEnabled = runtime.getSetting('CLOUDFLARE_GW_ENABLED') === 'true';
  const cloudflareAccountId = runtime.getSetting('CLOUDFLARE_AI_ACCOUNT_ID');
  const cloudflareGatewayId = runtime.getSetting('CLOUDFLARE_AI_GATEWAY_ID');

  const defaultUrl = 'https://api.groq.com/openai/v1';
  logger.debug('Cloudflare Gateway Configuration:', {
    isEnabled: isCloudflareEnabled,
    hasAccountId: !!cloudflareAccountId,
    hasGatewayId: !!cloudflareGatewayId,
    provider: provider,
  });

  if (!isCloudflareEnabled) {
    logger.debug('Cloudflare Gateway is not enabled');
    return defaultUrl;
  }

  if (!cloudflareAccountId) {
    logger.warn('Cloudflare Gateway is enabled but CLOUDFLARE_AI_ACCOUNT_ID is not set');
    return defaultUrl;
  }

  if (!cloudflareGatewayId) {
    logger.warn('Cloudflare Gateway is enabled but CLOUDFLARE_AI_GATEWAY_ID is not set');
    return defaultUrl;
  }

  const baseURL = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${cloudflareGatewayId}/${provider.toLowerCase()}`;
  logger.info('Using Cloudflare Gateway:', {
    provider,
    baseURL,
    accountId: cloudflareAccountId,
    gatewayId: cloudflareGatewayId,
  });

  return baseURL;
}

function findModelName(model: ModelTypeName): TiktokenModel {
  const name =
    model === ModelType.TEXT_SMALL
      ? (process.env.SMALL_GROQ_MODEL ?? 'llama-3.1-8b-instant')
      : (process.env.LARGE_GROQ_MODEL ?? 'llama-3.2-90b-vision-preview');
  return name as TiktokenModel;
}

async function tokenizeText(model: ModelTypeName, prompt: string) {
  const encoding = encodingForModel(findModelName(model));
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
  const modelName = findModelName(model);
  const encoding = encodingForModel(modelName);
  return encoding.decode(tokens);
}

export const groqPlugin: Plugin = {
  name: 'groq',
  description: 'Groq plugin',
  config: {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    SMALL_GROQ_MODEL: process.env.SMALL_GROQ_MODEL,
    MEDIUM_GROQ_MODEL: process.env.MEDIUM_GROQ_MODEL,
    LARGE_GROQ_MODEL: process.env.LARGE_GROQ_MODEL,
  },
  async init(config: Record<string, string>) {
    if (!process.env.GROQ_API_KEY) {
      throw Error('Missing GROQ_API_KEY in environment variables');
    }
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      const testVector = Array(1536).fill(0);
      testVector[0] = 0.1;
      return testVector;
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
      const max_response_length = 8000;
      const baseURL = getCloudflareGatewayBaseURL(runtime, 'groq');
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

      try {
        const { text: openaiResponse } = await generateText({
          model: groq.languageModel(model),
          prompt: prompt,
          system: runtime.character.system ?? undefined,
          temperature: temperature,
          maxTokens: max_response_length,
          frequencyPenalty: frequency_penalty,
          presencePenalty: presence_penalty,
          stopSequences: stopSequences,
        });

        return openaiResponse;
      } catch (error: unknown) {
        const err = error as Error;
        // Check if this is a rate limit error
        if (err?.message?.includes('Rate limit reached')) {
          logger.warn(`Groq rate limit reached for model ${model}`, { error: err.message });

          // Extract retry delay from error message if possible
          let retryDelay = 10000; // Default to 10 seconds
          const delayMatch = err.message.match(/try again in (\d+\.?\d*)s/i);
          if (delayMatch?.[1]) {
            // Convert to milliseconds and add a small buffer
            retryDelay = Math.ceil(Number.parseFloat(delayMatch[1]) * 1000) + 1000;
          }

          logger.info(`Will retry after ${retryDelay}ms delay`);

          // Wait for the suggested delay plus a small buffer
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          // Retry the request
          logger.info('Retrying request after rate limit delay');
          const { text: retryResponse } = await generateText({
            model: groq.languageModel(model),
            prompt: prompt,
            system: runtime.character.system ?? undefined,
            temperature: temperature,
            maxTokens: max_response_length,
            frequencyPenalty: frequency_penalty,
            presencePenalty: presence_penalty,
            stopSequences: stopSequences,
          });

          return retryResponse;
        }

        // For other errors, log and rethrow
        logger.error('Error generating text with Groq:', error);
        throw error;
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
      const model =
        runtime.getSetting('GROQ_LARGE_MODEL') ?? runtime.getSetting('LARGE_MODEL') ?? 'gpt-4444o';
      const baseURL = getCloudflareGatewayBaseURL(runtime, 'groq');
      const groq = createGroq({
        apiKey: runtime.getSetting('GROQ_API_KEY'),
        fetch: runtime.fetch,
        baseURL,
      });

      try {
        const { text: openaiResponse } = await generateText({
          model: groq.languageModel(model),
          prompt: prompt,
          system: runtime.character.system ?? undefined,
          temperature: temperature,
          maxTokens: maxTokens,
          frequencyPenalty: frequencyPenalty,
          presencePenalty: presencePenalty,
          stopSequences: stopSequences,
        });
        return openaiResponse;
      } catch (error: unknown) {
        const err = error as Error;
        // Check if this is a rate limit error
        if (err?.message?.includes('Rate limit reached')) {
          logger.warn(`Groq rate limit reached for model ${model}`, { error: err.message });

          // Extract retry delay from error message if possible
          let retryDelay = 10000; // Default to 10 seconds
          const delayMatch = err.message.match(/try again in (\d+\.?\d*)s/i);
          if (delayMatch?.[1]) {
            // Convert to milliseconds and add a small buffer
            retryDelay = Math.ceil(Number.parseFloat(delayMatch[1]) * 1000) + 1000;
          }

          logger.info(`Will retry after ${retryDelay}ms delay`);

          // Wait for the suggested delay plus a small buffer
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          // Retry the request
          logger.info('Retrying request after rate limit delay');
          const { text: retryResponse } = await generateText({
            model: groq.languageModel(model),
            prompt: prompt,
            system: runtime.character.system ?? undefined,
            temperature: temperature,
            maxTokens: maxTokens,
            frequencyPenalty: frequencyPenalty,
            presencePenalty: presencePenalty,
            stopSequences: stopSequences,
          });

          return retryResponse;
        }

        // For other errors, log and rethrow
        logger.error('Error generating text with Groq:', error);
        throw error;
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
      const baseURL = getCloudflareGatewayBaseURL(runtime, 'groq');
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
        throw new Error(`Failed to generate image: ${response.statusText}`);
      }
      const data = await response.json();
      const typedData = data as { data: { url: string }[] };
      return typedData.data;
    },
    [ModelType.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
      logger.log('audioBuffer', audioBuffer);
      const baseURL = getCloudflareGatewayBaseURL(runtime, 'groq');

      // Create a FormData instance
      const formData = new FormData();

      // Create a proper interface for FormData to avoid type errors
      interface EnhancedFormData extends FormData {
        append(name: string, value: string | Blob, fileName?: string): void;
      }

      // Cast to our enhanced interface
      const enhancedFormData = formData as EnhancedFormData;
      enhancedFormData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }));
      enhancedFormData.append('model', 'whisper-1');

      const response = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}`,
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
    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      const baseURL = getCloudflareGatewayBaseURL(runtime, 'groq');
      const groq = createGroq({
        apiKey: runtime.getSetting('GROQ_API_KEY'),
        baseURL,
      });
      const model =
        runtime.getSetting('GROQ_SMALL_MODEL') ??
        runtime.getSetting('SMALL_MODEL') ??
        'llama-3.1-8b-instangt';

      try {
        if (params.schema) {
          logger.info('Using OBJECT_SMALL without schema validation');
          const { object } = await generateObject({
            model: groq.languageModel(model),
            output: 'no-schema',
            prompt: params.prompt,
            temperature: params.temperature,
          });
          return object;
        }

        const { object } = await generateObject({
          model: groq.languageModel(model),
          output: 'no-schema',
          prompt: params.prompt,
          temperature: params.temperature,
        });
        return object;
      } catch (error) {
        logger.error('Error generating object:', error);
        throw error;
      }
    },
    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      const baseURL = getCloudflareGatewayBaseURL(runtime, 'groq');
      const groq = createGroq({
        apiKey: runtime.getSetting('GROQ_API_KEY'),
      });
      const model =
        runtime.getSetting('GROQ_LARGE_MODEL') ??
        runtime.getSetting('LARGE_MODEL') ??
        'llama-3.2-90b-vision-preview';

      try {
        if (params.schema) {
          logger.info('Using OBJECT_LARGE without schema validation');
          const { object } = await generateObject({
            model: groq.languageModel(model),
            output: 'no-schema',
            prompt: params.prompt,
            temperature: params.temperature,
          });
          return object;
        }

        const { object } = await generateObject({
          model: groq.languageModel(model),
          output: 'no-schema',
          prompt: params.prompt,
          temperature: params.temperature,
        });
        return object;
      } catch (error) {
        logger.error('Error generating object:', error);
        throw error;
      }
    },
  },
};
export default groqPlugin;
