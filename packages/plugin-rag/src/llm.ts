import { generateText as aiGenerateText, embed, GenerateTextResult } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { google } from '@ai-sdk/google';
import z from 'zod';

// Schema for validating model configuration
export const ModelConfigSchema = z.object({
  // Provider configuration
  EMBEDDING_PROVIDER: z.enum(['openai', 'google']),
  TEXT_PROVIDER: z.enum(['openai', 'anthropic', 'openrouter', 'google']),

  // API keys
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  // Base URLs (optional for most providers)
  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().optional(),
  GOOGLE_BASE_URL: z.string().optional(),

  // Model names
  TEXT_EMBEDDING_MODEL: z.string(),
  TEXT_MODEL: z.string(),

  // Token limits
  MAX_INPUT_TOKENS: z
    .string()
    .or(z.number())
    .transform((val) => (typeof val === 'string' ? parseInt(val, 10) : val)),
  MAX_OUTPUT_TOKENS: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === 'string' ? parseInt(val, 10) : val) : 4096)),

  // Embedding dimension
  // For OpenAI: Only applies to text-embedding-3-small and text-embedding-3-large models
  // Default: 1536 dimensions
  EMBEDDING_DIMENSION: z
    .string()
    .or(z.number())
    .optional()
    .transform((val) => (val ? (typeof val === 'string' ? parseInt(val, 10) : val) : 1536)),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Interface for provider rate limits
 */
export interface ProviderRateLimits {
  // Maximum concurrent requests recommended for this provider
  maxConcurrentRequests: number;
  // Maximum requests per minute allowed
  requestsPerMinute: number;
  // Maximum tokens per minute allowed (if applicable)
  tokensPerMinute?: number;
  // Name of the provider
  provider: string;
}

/**
 * Returns rate limit information for the configured providers
 *
 * @returns Rate limit configuration for the current providers
 */
export async function getProviderRateLimits(): Promise<ProviderRateLimits> {
  const config = validateModelConfig();

  // Default rate limits if not specified by environment variables
  let maxConcurrentRequests = 30;
  let requestsPerMinute = 60;
  let tokensPerMinute = 150000;

  // Check for environment variable overrides
  if (process.env.MAX_CONCURRENT_REQUESTS) {
    maxConcurrentRequests = parseInt(process.env.MAX_CONCURRENT_REQUESTS, 10);
  }

  if (process.env.REQUESTS_PER_MINUTE) {
    requestsPerMinute = parseInt(process.env.REQUESTS_PER_MINUTE, 10);
  }

  if (process.env.TOKENS_PER_MINUTE) {
    tokensPerMinute = parseInt(process.env.TOKENS_PER_MINUTE, 10);
  }

  // Provider-specific rate limits based on research
  // These can be overridden by the environment variables above
  switch (config.EMBEDDING_PROVIDER) {
    case 'openai':
      // OpenAI typically allows 150,000 tokens per minute for embeddings
      // and up to 3,000 RPM for Tier 4+ accounts
      return {
        maxConcurrentRequests,
        requestsPerMinute: Math.min(requestsPerMinute, 3000),
        tokensPerMinute: Math.min(tokensPerMinute, 150000),
        provider: 'openai',
      };

    case 'google':
      // Google's default is 60 requests per minute
      return {
        maxConcurrentRequests,
        requestsPerMinute: Math.min(requestsPerMinute, 60),
        tokensPerMinute: Math.min(tokensPerMinute, 100000),
        provider: 'google',
      };

    default:
      // Use default values for unknown providers
      return {
        maxConcurrentRequests,
        requestsPerMinute,
        tokensPerMinute,
        provider: config.EMBEDDING_PROVIDER,
      };
  }
}

/**
 * Validates the model configuration from environment variables
 * @returns The validated configuration or throws an error
 */
export function validateModelConfig(): ModelConfig {
  try {
    const config = ModelConfigSchema.parse({
      EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
      TEXT_PROVIDER: process.env.TEXT_PROVIDER,

      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,

      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
      GOOGLE_BASE_URL: process.env.GOOGLE_BASE_URL,

      TEXT_EMBEDDING_MODEL: process.env.TEXT_EMBEDDING_MODEL,
      TEXT_MODEL: process.env.TEXT_MODEL,

      MAX_INPUT_TOKENS: process.env.MAX_INPUT_TOKENS || 4000,
      MAX_OUTPUT_TOKENS: process.env.MAX_OUTPUT_TOKENS || 4096,

      EMBEDDING_DIMENSION: process.env.EMBEDDING_DIMENSION || 1536,
    });

    // Additional validation: Make sure the API key for selected providers exists
    if (config.EMBEDDING_PROVIDER === 'openai' && !config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER is set to "openai"');
    }
    if (config.EMBEDDING_PROVIDER === 'google' && !config.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when EMBEDDING_PROVIDER is set to "google"');
    }
    if (config.TEXT_PROVIDER === 'openai' && !config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when TEXT_PROVIDER is set to "openai"');
    }
    if (config.TEXT_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required when TEXT_PROVIDER is set to "anthropic"');
    }
    if (config.TEXT_PROVIDER === 'openrouter' && !config.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required when TEXT_PROVIDER is set to "openrouter"');
    }
    if (config.TEXT_PROVIDER === 'google' && !config.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when TEXT_PROVIDER is set to "google"');
    }

    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
      throw new Error(`Model configuration validation failed: ${issues}`);
    }
    throw error;
  }
}

/**
 * Generates text embeddings using the configured provider
 * @param text The text to embed
 * @returns The embedding vector
 */
export async function generateTextEmbedding(text: string): Promise<{ embedding: number[] }> {
  const config = validateModelConfig();
  const dimensions = config.EMBEDDING_DIMENSION;

  console.log('config', config);
  console.log('dimensions', dimensions);

  try {
    if (config.EMBEDDING_PROVIDER === 'openai') {
      const openai = createOpenAI({
        apiKey: config.OPENAI_API_KEY as string,
        baseURL: config.OPENAI_BASE_URL,
      });

      // Some OpenAI models support dimension parameter at initialization time
      const modelOptions: Record<string, any> = {};
      if (
        dimensions &&
        ['text-embedding-3-small', 'text-embedding-3-large'].includes(config.TEXT_EMBEDDING_MODEL)
      ) {
        modelOptions.dimensions = dimensions;
      }

      const modelInstance = openai.embedding(config.TEXT_EMBEDDING_MODEL, modelOptions);

      const { embedding, usage } = await embed({
        model: modelInstance,
        value: text,
      });

      const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
      const usageMessage = totalTokens ? `${totalTokens} total tokens` : 'Usage details N/A';
      console.log(
        `[LLM Service - OpenAI Embedding] Generated using ${config.TEXT_EMBEDDING_MODEL}${
          modelOptions.dimensions ? ` with configured dimension ${modelOptions.dimensions}` : ''
        }. Usage: ${usageMessage}.`
      );

      return { embedding };
    } else if (config.EMBEDDING_PROVIDER === 'google') {
      // Create the provider instance with API key config
      const googleProvider = google;
      if (config.GOOGLE_API_KEY) {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
      }

      // Google Embeddings API doesn't support dimension parameter at the AI SDK level yet
      // If needed, set the dimension at the API level through model selection
      const modelInstance = googleProvider.textEmbeddingModel(config.TEXT_EMBEDDING_MODEL);

      const { embedding, usage } = await embed({
        model: modelInstance,
        value: text,
      });

      const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
      const usageMessage = totalTokens ? `${totalTokens} total tokens` : 'Usage details N/A';
      console.log(
        `[LLM Service - Google Embedding] Generated using ${config.TEXT_EMBEDDING_MODEL}. Usage: ${usageMessage}.`
      );

      return { embedding };
    }

    throw new Error(`Unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`);
  } catch (error) {
    console.error(
      `[LLM Service - ${config.EMBEDDING_PROVIDER} Embedding] Error generating embedding:`,
      error
    );
    throw error;
  }
}

/**
 * Generates text using the configured provider
 * @param prompt The prompt text
 * @param system Optional system message
 * @param overrideConfig Optional configuration overrides
 * @returns The generated text result
 *
 * @example
 * // Example using OpenRouter with Anthropic prompt caching for contextual retrieval
 * const result = await generateText(
 *   "Enhance this chunk with context: " + chunk,
 *   "You are a precision text augmentation tool.",
 *   {
 *     provider: "openrouter",
 *     modelName: "anthropic/claude-3.5-sonnet",
 *     cacheDocument: documentText,  // The full document text to cache
 *     cacheOptions: { type: "ephemeral" }
 *   }
 * );
 *
 * // This caches the document and reuses it efficiently for multiple chunk processing
 * // reducing costs by up to 90% for subsequent calls with the same document
 */
export async function generateText(
  prompt: string,
  system?: string,
  overrideConfig?: {
    provider?: 'anthropic' | 'openai' | 'openrouter' | 'google';
    modelName?: string;
    maxTokens?: number;
    /**
     * Document to cache for contextual retrieval.
     * When provided (along with an Anthropic model via OpenRouter), this enables prompt caching.
     * The document is cached with the provider and subsequent requests will reuse the cached document,
     * significantly reducing costs for multiple operations on the same document.
     * Most effective with contextual retrieval for RAG applications.
     */
    cacheDocument?: string;

    /**
     * Options for controlling the cache behavior.
     * Currently supports { type: 'ephemeral' } which sets up a temporary cache.
     * Cache expires after approximately 5 minutes with Anthropic models.
     * This can reduce costs by up to 90% for reads after the initial cache write.
     */
    cacheOptions?: {
      type: 'ephemeral';
    };
    /**
     * Whether to automatically detect and enable caching for contextual retrieval.
     * Default is true for OpenRouter+Anthropic models with document-chunk prompts.
     * Set to false to disable automatic caching detection.
     */
    autoCacheContextualRetrieval?: boolean;
  }
): Promise<GenerateTextResult<any, any>> {
  const config = validateModelConfig();
  const provider = overrideConfig?.provider || config.TEXT_PROVIDER;
  const modelName = overrideConfig?.modelName || config.TEXT_MODEL;
  const maxTokens = overrideConfig?.maxTokens || config.MAX_OUTPUT_TOKENS;

  // Auto-detect contextual retrieval prompts for caching - enabled by default
  const autoCacheContextualRetrieval = overrideConfig?.autoCacheContextualRetrieval !== false;

  try {
    if (provider === 'anthropic') {
      const anthropic = createAnthropic({
        apiKey: config.ANTHROPIC_API_KEY as string,
        baseURL: config.ANTHROPIC_BASE_URL,
      });

      const modelInstance = anthropic(modelName);

      const result = await aiGenerateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: maxTokens,
      });

      console.log(
        `[LLM Service - Anthropic] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );

      return result;
    } else if (provider === 'openai') {
      const openai = createOpenAI({
        apiKey: config.OPENAI_API_KEY as string,
        baseURL: config.OPENAI_BASE_URL,
      });

      const modelInstance = openai.chat(modelName);

      const result = await aiGenerateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: maxTokens,
      });

      console.log(
        `[LLM Service - OpenAI] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );

      return result;
    } else if (provider === 'openrouter') {
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
      let documentForCaching: string | undefined = overrideConfig?.cacheDocument;

      if (!documentForCaching && autoCacheContextualRetrieval && supportsCaching) {
        // Try to extract document from the prompt if it contains document tags
        const docMatch = prompt.match(/<document>([\s\S]*?)<\/document>/);
        if (docMatch && docMatch[1]) {
          documentForCaching = docMatch[1].trim();
          console.log(
            `[LLM Service - OpenRouter] Auto-detected document for caching (${documentForCaching.length} chars)`
          );
        }
      }

      // Only apply caching if we have a document to cache
      if (documentForCaching && supportsCaching) {
        // Define a consistent cache ID based on document content
        const cacheOptions = overrideConfig?.cacheOptions || { type: 'ephemeral' };

        // Parse out the prompt part - if it's a contextual query, strip document tags
        let promptText = prompt;
        if (promptText.includes('<document>')) {
          promptText = promptText.replace(/<document>[\s\S]*?<\/document>/, '').trim();
        }

        // For Claude model with explicit caching, we need to follow exact OpenRouter format
        if (isClaudeModel) {
          console.log(
            `[LLM Service - OpenRouter] Using explicit prompt caching with Claude model ${modelName}`
          );

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

          console.log('[LLM Service - OpenRouter] Using Claude-specific caching structure');

          // Generate text with cache-enabled structured messages
          const result = await aiGenerateText({
            model: modelInstance,
            messages: messages as any,
            temperature: 0.7,
            maxTokens: maxTokens,
            providerOptions: {
              openrouter: {
                usage: {
                  include: true, // Include usage info to see cache metrics
                },
              },
            },
          });

          // Log detailed cache usage info if available
          if (result.usage && (result.usage as any).cacheTokens) {
            console.log(
              `[LLM Service - OpenRouter] Cache metrics - ` +
                `Cached tokens: ${(result.usage as any).cacheTokens}, ` +
                `Cache discount: ${(result.usage as any).cacheDiscount}`
            );
          }

          console.log(
            `[LLM Service - OpenRouter] Text generated with ${modelName} using Claude caching. ` +
              `Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
          );

          return result;
        } else if (isGeminiModel) {
          // Gemini models support implicit caching as of 2.5 models
          const usingImplicitCaching = isGemini25Model;

          // Check if document is large enough for implicit caching
          // Gemini 2.5 Flash requires minimum 1028 tokens, Gemini 2.5 Pro requires 2048 tokens
          const estimatedDocTokens = Math.ceil(documentForCaching.length / 4); // Rough estimate of tokens
          const minTokensForImplicitCache = modelName.toLowerCase().includes('flash') ? 1028 : 2048;
          const likelyTriggersCaching = estimatedDocTokens >= minTokensForImplicitCache;

          if (usingImplicitCaching) {
            console.log(
              `[LLM Service - OpenRouter] Using Gemini 2.5 implicit caching with model ${modelName}`
            );
            console.log(
              `[LLM Service - OpenRouter] Gemini 2.5 models automatically cache large prompts (no cache_control needed)`
            );

            if (likelyTriggersCaching) {
              console.log(
                `[LLM Service - OpenRouter] Document size ~${estimatedDocTokens} tokens exceeds minimum ${minTokensForImplicitCache} tokens for implicit caching`
              );
            } else {
              console.log(
                `[LLM Service - OpenRouter] Warning: Document size ~${estimatedDocTokens} tokens may not meet minimum ${minTokensForImplicitCache} token threshold for implicit caching`
              );
            }
          } else {
            console.log(
              `[LLM Service - OpenRouter] Using standard prompt format with Gemini model ${modelName}`
            );
            console.log(
              `[LLM Service - OpenRouter] Note: Only Gemini 2.5 models support automatic implicit caching`
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
            temperature: 0.7,
            maxTokens: maxTokens,
            providerOptions: {
              openrouter: {
                usage: {
                  include: true, // Include usage info to see cache metrics
                },
              },
            },
          });

          // Log detailed cache usage info if available
          if (result.usage && (result.usage as any).cacheTokens) {
            console.log(
              `[LLM Service - OpenRouter] Cache metrics - ` +
                `Cached tokens: ${(result.usage as any).cacheTokens}, ` +
                `Cache discount: ${(result.usage as any).cacheDiscount}`
            );
          }

          console.log(
            `[LLM Service - OpenRouter] Text generated with ${modelName} using ${usingImplicitCaching ? 'implicit' : 'standard'} caching. ` +
              `Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
          );

          return result;
        }
      }

      // Standard request without caching
      console.log('[LLM Service - OpenRouter] Using standard request without caching');
      const result = await aiGenerateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: maxTokens,
        providerOptions: {
          openrouter: {
            usage: {
              include: true, // Include usage info to see cache metrics
            },
          },
        },
      });

      console.log(
        `[LLM Service - OpenRouter] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );

      return result;
    } else if (provider === 'google') {
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
        temperature: 0.7,
        maxTokens: maxTokens,
      });

      console.log(
        `[LLM Service - Google] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );

      return result;
    }

    throw new Error(`Unsupported text provider: ${provider}`);
  } catch (error) {
    console.error(`[LLM Service - ${provider}] Error generating text with ${modelName}:`, error);
    throw error;
  }
}
