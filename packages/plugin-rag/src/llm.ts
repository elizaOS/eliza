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

  try {
    if (config.EMBEDDING_PROVIDER === 'openai') {
      const openai = createOpenAI({
        apiKey: config.OPENAI_API_KEY as string,
        baseURL: config.OPENAI_BASE_URL,
      });

      const modelInstance = openai.embedding(config.TEXT_EMBEDDING_MODEL);

      const { embedding, usage } = await embed({
        model: modelInstance,
        value: text,
      });

      const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
      const usageMessage = totalTokens ? `${totalTokens} total tokens` : 'Usage details N/A';
      console.log(
        `[LLM Service - OpenAI Embedding] Generated using ${config.TEXT_EMBEDDING_MODEL}. Usage: ${usageMessage}.`
      );

      return { embedding };
    } else if (config.EMBEDDING_PROVIDER === 'google') {
      // Create the provider instance with API key config
      const googleProvider = google;
      if (config.GOOGLE_API_KEY) {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
      }

      // For Google embeddings, we use textEmbeddingModel factory method
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
 */
export async function generateText(
  prompt: string,
  system?: string,
  overrideConfig?: {
    provider?: 'anthropic' | 'openai' | 'openrouter' | 'google';
    modelName?: string;
    maxTokens?: number;
  }
): Promise<GenerateTextResult<any, any>> {
  const config = validateModelConfig();
  const provider = overrideConfig?.provider || config.TEXT_PROVIDER;
  const modelName = overrideConfig?.modelName || config.TEXT_MODEL;
  const maxTokens = overrideConfig?.maxTokens || config.MAX_OUTPUT_TOKENS;

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

      const result = await aiGenerateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: maxTokens,
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
