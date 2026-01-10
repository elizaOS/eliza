import { generateText as aiGenerateText, embed, GenerateTextResult } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { google } from '@ai-sdk/google';
import { ModelConfig, TextGenerationOptions } from './types';
import { validateModelConfig } from './config';
import { logger, IAgentRuntime } from '@elizaos/core';

// Re-export for backwards compatibility
export { validateModelConfig } from './config';
export { getProviderRateLimits } from './config';
export type { ModelConfig, ProviderRateLimits } from './types';

/**
 * Generates text embeddings using the configured provider
 * @param text The text to embed
 * @returns The embedding vector
 */
export async function generateTextEmbedding(
  runtime: IAgentRuntime,
  text: string
): Promise<{ embedding: number[] }> {
  const config = validateModelConfig(runtime);
  const dimensions = config.EMBEDDING_DIMENSION;

  try {
    if (config.EMBEDDING_PROVIDER === 'openai') {
      return await generateOpenAIEmbedding(text, config, dimensions);
    } else if (config.EMBEDDING_PROVIDER === 'google') {
      return await generateGoogleEmbedding(text, config);
    }

    throw new Error(`Unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`);
  } catch (error) {
    logger.error({ error }, `[Document Processor] ${config.EMBEDDING_PROVIDER} embedding error`);
    throw error;
  }
}

/**
 * Generates text embeddings in batches for improved performance
 * @param texts Array of texts to embed
 * @param batchSize Maximum number of texts to process in each batch (default: 20)
 * @returns Array of embedding results with success indicators
 */
export async function generateTextEmbeddingsBatch(
  runtime: IAgentRuntime,
  texts: string[],
  batchSize: number = 20
): Promise<Array<{ embedding: number[] | null; success: boolean; error?: any; index: number }>> {
  const config = validateModelConfig(runtime);
  const results: Array<{
    embedding: number[] | null;
    success: boolean;
    error?: any;
    index: number;
  }> = [];

  logger.debug(
    `[Document Processor] Processing ${texts.length} embeddings in batches of ${batchSize}`
  );

  // Process texts in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchStartIndex = i;

    logger.debug(
      `[Document Processor] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} items)`
    );

    // Process batch in parallel
    const batchPromises = batch.map(async (text, batchIndex) => {
      const globalIndex = batchStartIndex + batchIndex;
      try {
        const result = await generateTextEmbedding(runtime, text);
        return {
          embedding: result.embedding,
          success: true,
          index: globalIndex,
        };
      } catch (error) {
        logger.error({ error }, `[Document Processor] Embedding error for item ${globalIndex}`);
        return {
          embedding: null,
          success: false,
          error,
          index: globalIndex,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Add a small delay between batches to respect rate limits
    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;

  logger.debug(
    `[Document Processor] Embedding batch complete: ${successCount} success, ${failureCount} failures`
  );

  return results;
}

/**
 * Generates an embedding using OpenAI
 */
async function generateOpenAIEmbedding(
  text: string,
  config: ModelConfig,
  dimensions: number
): Promise<{ embedding: number[] }> {
  const openai = createOpenAI({
    apiKey: config.OPENAI_API_KEY as string,
    baseURL: config.OPENAI_BASE_URL,
  });

  // Create the embedding model instance
  const modelInstance = openai.embedding(config.TEXT_EMBEDDING_MODEL);

  // Some OpenAI models support dimension parameter
  const embedOptions: any = {
    model: modelInstance,
    value: text,
  };

  if (
    dimensions &&
    ['text-embedding-3-small', 'text-embedding-3-large'].includes(config.TEXT_EMBEDDING_MODEL)
  ) {
    embedOptions.dimensions = dimensions;
  }

  const { embedding, usage } = await embed(embedOptions);

  const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
  const usageMessage = totalTokens ? `${totalTokens} total tokens` : 'Usage details N/A';
  logger.debug(
    `[Document Processor] OpenAI embedding ${config.TEXT_EMBEDDING_MODEL}${embedOptions.dimensions ? ` (${embedOptions.dimensions}D)` : ''}: ${usageMessage}`
  );

  return { embedding };
}

/**
 * Generates an embedding using Google
 */
async function generateGoogleEmbedding(
  text: string,
  config: ModelConfig
): Promise<{ embedding: number[] }> {
  // Create the provider instance with API key config
  const googleProvider = google;
  if (config.GOOGLE_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
  }

  // Google Embeddings API doesn't support dimension parameter at the AI SDK level yet
  const modelInstance = googleProvider.textEmbeddingModel(config.TEXT_EMBEDDING_MODEL);

  const { embedding, usage } = await embed({
    model: modelInstance,
    value: text,
  });

  const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
  const usageMessage = totalTokens ? `${totalTokens} total tokens` : 'Usage details N/A';
  logger.debug(
    `[Document Processor] Google embedding ${config.TEXT_EMBEDDING_MODEL}: ${usageMessage}`
  );

  return { embedding };
}

/**
 * Generates text using the configured provider
 * @param prompt The prompt text
 * @param system Optional system message
 * @param overrideConfig Optional configuration overrides
 * @returns The generated text result
 *
 * @example
 * // Regular text generation
 * const response = await generateText("Summarize this article: " + articleText);
 *
 * @example
 * // Text generation with system prompt
 * const response = await generateText(
 *   "Summarize this article: " + articleText,
 *   "You are a helpful assistant specializing in concise summaries."
 * );
 *
 * @example
 * // Using document caching with OpenRouter (available with Claude and Gemini models)
 * // This can reduce costs up to 90% when working with the same document repeatedly
 * const response = await generateText(
 *   "Extract key topics from this chunk: " + chunk,
 *   "You are a precision information extraction tool.",
 *   {
 *     cacheDocument: documentText,  // The full document to cache
 *     cacheOptions: { type: "ephemeral" }
 *   }
 * );
 */
export async function generateText(
  runtime: IAgentRuntime,
  prompt: string,
  system?: string,
  overrideConfig?: TextGenerationOptions
): Promise<GenerateTextResult<any, any>> {
  const config = validateModelConfig(runtime);
  const provider = overrideConfig?.provider || config.TEXT_PROVIDER;
  const modelName = overrideConfig?.modelName || config.TEXT_MODEL;
  const maxTokens = overrideConfig?.maxTokens || config.MAX_OUTPUT_TOKENS;

  // Auto-detect contextual retrieval prompts for caching - enabled by default
  const autoCacheContextualRetrieval = overrideConfig?.autoCacheContextualRetrieval !== false;

  try {
    switch (provider) {
      case 'anthropic':
        return await generateAnthropicText(config, prompt, system, modelName!, maxTokens);
      case 'openai':
        return await generateOpenAIText(config, prompt, system, modelName!, maxTokens);
      case 'openrouter':
        return await generateOpenRouterText(
          config,
          prompt,
          system,
          modelName!,
          maxTokens,
          overrideConfig?.cacheDocument,
          overrideConfig?.cacheOptions,
          autoCacheContextualRetrieval
        );
      case 'google':
        return await generateGoogleText(prompt, system, modelName!, maxTokens, config);
      default:
        throw new Error(`Unsupported text provider: ${provider}`);
    }
  } catch (error) {
    logger.error({ error }, `[Document Processor] ${provider} ${modelName} error`);
    throw error;
  }
}

/**
 * Generates text using the Anthropic API with exponential backoff retry
 */
async function generateAnthropicText(
  config: ModelConfig,
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number
): Promise<GenerateTextResult<any, any>> {
  const anthropic = createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY as string,
    baseURL: config.ANTHROPIC_BASE_URL,
  });

  const modelInstance = anthropic(modelName);

  // Retry with exponential backoff for rate limit errors
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await aiGenerateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.3,
        maxOutputTokens: maxTokens,
      });

      const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
      logger.debug(
        `[Document Processor] ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
      );

      return result;
    } catch (error: any) {
      // Check if it's a rate limit error (status 429)
      const isRateLimit =
        error?.status === 429 ||
        error?.message?.includes('rate limit') ||
        error?.message?.includes('429');

      if (isRateLimit && attempt < maxRetries - 1) {
        // Exponential backoff: 2^attempt seconds (2s, 4s, 8s)
        const delay = Math.pow(2, attempt + 1) * 1000;
        logger.warn(
          `[Document Processor] Rate limit hit (${modelName}): attempt ${attempt + 1}/${maxRetries}, retrying in ${Math.round(delay / 1000)}s`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Re-throw error if not rate limit or max retries exceeded
      throw error;
    }
  }

  throw new Error('Max retries exceeded for Anthropic text generation');
}

/**
 * Generates text using the OpenAI API
 */
async function generateOpenAIText(
  config: ModelConfig,
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number
): Promise<GenerateTextResult<any, any>> {
  const openai = createOpenAI({
    apiKey: config.OPENAI_API_KEY as string,
    baseURL: config.OPENAI_BASE_URL,
  });

  const modelInstance = openai.chat(modelName);

  const result = await aiGenerateText({
    model: modelInstance,
    prompt: prompt,
    system: system,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
  });

  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenAI ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

/**
 * Generates text using Google's API
 */
async function generateGoogleText(
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number,
  config: ModelConfig
): Promise<GenerateTextResult<any, any>> {
  // Use the google provider directly
  const googleProvider = google;
  if (config.GOOGLE_API_KEY) {
    // Google provider uses env var GOOGLE_GENERATIVE_AI_API_KEY by default
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
  }

  // Create model instance directly from google provider
  const modelInstance = googleProvider(modelName);

  const result = await aiGenerateText({
    model: modelInstance,
    prompt: prompt,
    system: system,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
  });

  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] Google ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

/**
 * Generates text using OpenRouter with optional document caching
 *
 * Document caching is a powerful feature for RAG applications that can significantly
 * reduce token costs when working with the same document repeatedly. It works by:
 *
 * 1. For Claude models: Explicitly caching the document with Claude's cache_control API
 * 2. For Gemini 2.5+ models: Leveraging implicit caching through consistent prompt structure
 *
 * Caching can reduce costs by up to 90% for subsequent queries on the same document.
 * This is especially valuable for contextual RAG applications.
 *
 * Requirements:
 * - Claude models: Require explicit cache_control API
 * - Gemini 2.5 models: Require minimum document size (2048 tokens for Pro, 1028 for Flash)
 *
 * @private
 */
async function generateOpenRouterText(
  config: ModelConfig,
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number,
  cacheDocument?: string,
  _cacheOptions?: { type: 'ephemeral' },
  autoCacheContextualRetrieval = true
): Promise<GenerateTextResult<any, any>> {
  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY as string,
    baseURL: config.OPENROUTER_BASE_URL,
  });

  const modelInstance = openrouter.chat(modelName);

  // Determine if this is a Claude or Gemini model for caching
  const isClaudeModel = modelName.toLowerCase().includes('claude');
  const isGeminiModel = modelName.toLowerCase().includes('gemini');
  const isGemini25Model = modelName.toLowerCase().includes('gemini-2.5');
  const supportsCaching = isClaudeModel || isGeminiModel;

  // Extract document for caching from explicit param or auto-detect from prompt
  let documentForCaching: string | undefined = cacheDocument;

  if (!documentForCaching && autoCacheContextualRetrieval && supportsCaching) {
    // Try to extract document from the prompt if it contains document tags
    const docMatch = prompt.match(/<document>([\s\S]*?)<\/document>/);
    if (docMatch && docMatch[1]) {
      documentForCaching = docMatch[1].trim();
      logger.debug(
        `[Document Processor] Auto-detected document for caching (${documentForCaching.length} chars)`
      );
    }
  }

  // Only apply caching if we have a document to cache
  if (documentForCaching && supportsCaching) {
    // Parse out the prompt part - if it's a contextual query, strip document tags
    let promptText = prompt;
    if (promptText.includes('<document>')) {
      promptText = promptText.replace(/<document>[\s\S]*?<\/document>/, '').trim();
    }

    if (isClaudeModel) {
      return await generateClaudeWithCaching(
        promptText,
        system,
        modelInstance,
        modelName,
        maxTokens,
        documentForCaching
      );
    } else if (isGeminiModel) {
      return await generateGeminiWithCaching(
        promptText,
        system,
        modelInstance,
        modelName,
        maxTokens,
        documentForCaching,
        isGemini25Model
      );
    }
  }

  // Standard request without caching
  logger.debug('[Document Processor] Using standard request without caching');
  return await generateStandardOpenRouterText(prompt, system, modelInstance, modelName, maxTokens);
}

/**
 * Generates text using Claude with caching via OpenRouter
 */
async function generateClaudeWithCaching(
  promptText: string,
  system: string | undefined,
  modelInstance: any,
  modelName: string,
  maxTokens: number,
  documentForCaching: string
): Promise<GenerateTextResult<any, any>> {
  logger.debug(`[Document Processor] Using explicit prompt caching with Claude ${modelName}`);

  // Structure for Claude models
  const messages = [
    // System message with cached document (if system is provided)
    system
      ? {
          role: 'system',
          content: [
            {
              type: 'text',
              text: system,
            },
            {
              type: 'text',
              text: documentForCaching,
              cache_control: {
                type: 'ephemeral',
              },
            },
          ],
        }
      : // User message with cached document (if no system message)
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Document for context:',
            },
            {
              type: 'text',
              text: documentForCaching,
              cache_control: {
                type: 'ephemeral',
              },
            },
            {
              type: 'text',
              text: promptText,
            },
          ],
        },
    // Only add user message if system was provided (otherwise we included user above)
    system
      ? {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptText,
            },
          ],
        }
      : null,
  ].filter(Boolean);

  logger.debug('[Document Processor] Using Claude-specific caching structure');

  // Generate text with cache-enabled structured messages
  const result = await aiGenerateText({
    model: modelInstance,
    messages: messages as any,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
    providerOptions: {
      openrouter: {
        usage: {
          include: true,
        },
      },
    },
  });

  logCacheMetrics(result);
  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

/**
 * Generates text using Gemini with caching via OpenRouter
 */
async function generateGeminiWithCaching(
  promptText: string,
  system: string | undefined,
  modelInstance: any,
  modelName: string,
  maxTokens: number,
  documentForCaching: string,
  isGemini25Model: boolean
): Promise<GenerateTextResult<any, any>> {
  // Gemini models support implicit caching as of 2.5 models
  const usingImplicitCaching = isGemini25Model;

  // Check if document is large enough for implicit caching
  // Gemini 2.5 Flash requires minimum 1028 tokens, Gemini 2.5 Pro requires 2048 tokens
  const estimatedDocTokens = Math.ceil(documentForCaching.length / 4); // Rough estimate of tokens
  const minTokensForImplicitCache = modelName.toLowerCase().includes('flash') ? 1028 : 2048;
  const likelyTriggersCaching = estimatedDocTokens >= minTokensForImplicitCache;

  if (usingImplicitCaching) {
    logger.debug(`[Document Processor] Using Gemini 2.5 implicit caching with ${modelName}`);
    logger.debug(
      `[Document Processor] Gemini 2.5 models automatically cache large prompts (no cache_control needed)`
    );

    if (likelyTriggersCaching) {
      logger.debug(
        `[Document Processor] Document ~${estimatedDocTokens} tokens exceeds ${minTokensForImplicitCache} token threshold for caching`
      );
    } else {
      logger.debug(
        `[Document Processor] Document ~${estimatedDocTokens} tokens may not meet ${minTokensForImplicitCache} token threshold for caching`
      );
    }
  } else {
    logger.debug(`[Document Processor] Using standard prompt format with Gemini ${modelName}`);
    logger.debug(
      `[Document Processor] Note: Only Gemini 2.5 models support automatic implicit caching`
    );
  }

  // For Gemini models, we use a simpler format that works well with OpenRouter
  // The key for implicit caching is to keep the initial parts of the prompt consistent
  const geminiSystemPrefix = system ? `${system}\n\n` : '';

  // Format consistent with OpenRouter and Gemini expectations
  const geminiPrompt = `${geminiSystemPrefix}${documentForCaching}\n\n${promptText}`;

  // Generate text with simple prompt structure to leverage implicit caching
  const result = await aiGenerateText({
    model: modelInstance,
    prompt: geminiPrompt,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
    providerOptions: {
      openrouter: {
        usage: {
          include: true, // Include usage info to see cache metrics
        },
      },
    },
  });

  logCacheMetrics(result);
  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  const cachingType = usingImplicitCaching ? 'implicit' : 'standard';
  logger.debug(
    `[Document Processor] OpenRouter ${modelName} (${cachingType} caching): ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

/**
 * Generates text using standard OpenRouter API (no caching)
 */
async function generateStandardOpenRouterText(
  prompt: string,
  system: string | undefined,
  modelInstance: any,
  modelName: string,
  maxTokens: number
): Promise<GenerateTextResult<any, any>> {
  const result = await aiGenerateText({
    model: modelInstance,
    prompt: prompt,
    system: system,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
    providerOptions: {
      openrouter: {
        usage: {
          include: true, // Include usage info to see cache metrics
        },
      },
    },
  });

  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

/**
 * Logs cache metrics if available in the result
 */
function logCacheMetrics(result: GenerateTextResult<any, any>): void {
  if (result.usage && (result.usage as any).cacheTokens) {
    logger.debug(
      `[Document Processor] Cache metrics - tokens: ${(result.usage as any).cacheTokens}, discount: ${(result.usage as any).cacheDiscount}`
    );
  }
}
