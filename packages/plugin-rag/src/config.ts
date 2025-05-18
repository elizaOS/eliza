import { ModelConfig, ModelConfigSchema, ProviderRateLimits } from './types';
import z from 'zod';
import { logger } from '@elizaos/core';

/**
 * Validates the model configuration from environment variables
 * @returns The validated configuration or throws an error
 */
export function validateModelConfig(): ModelConfig {
  try {
    // Determine if contextual RAG is enabled
    const ctxRagEnabled = process.env.CTX_RAG_ENABLED === 'true';
    logger.debug(`Configuration: CTX_RAG_ENABLED=${ctxRagEnabled}`);

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

      CTX_RAG_ENABLED: ctxRagEnabled,
    });

    validateConfigRequirements(config);
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
 * Validates the required API keys and configuration based on the selected mode
 * @param config The model configuration to validate
 * @throws Error if a required configuration value is missing
 */
function validateConfigRequirements(config: ModelConfig): void {
  // First, always validate embedding provider since it's required in both modes
  if (config.EMBEDDING_PROVIDER === 'openai' && !config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER is set to "openai"');
  }
  if (config.EMBEDDING_PROVIDER === 'google' && !config.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is required when EMBEDDING_PROVIDER is set to "google"');
  }

  // If Contextual RAG is enabled, we need additional validations
  if (config.CTX_RAG_ENABLED) {
    logger.info('Contextual RAG is enabled. Validating text generation settings...');

    // Text provider and model are required for CTX_RAG
    if (!config.TEXT_PROVIDER) {
      throw new Error('TEXT_PROVIDER is required when CTX_RAG_ENABLED is true');
    }

    if (!config.TEXT_MODEL) {
      throw new Error('TEXT_MODEL is required when CTX_RAG_ENABLED is true');
    }

    // Validate API keys based on the text provider
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

    // If using OpenRouter with Claude or Gemini models, check for additional recommended configurations
    if (config.TEXT_PROVIDER === 'openrouter') {
      const modelName = config.TEXT_MODEL?.toLowerCase() || '';
      if (modelName.includes('claude') || modelName.includes('gemini')) {
        logger.info(
          `Using ${modelName} with OpenRouter. This configuration supports document caching for improved performance.`
        );
      }
    }
  } else {
    logger.info('Contextual RAG is disabled. Using basic embedding-only configuration.');
  }
}

/**
 * Returns rate limit information for the configured providers
 *
 * @returns Rate limit configuration for the current providers
 */
export async function getProviderRateLimits(): Promise<ProviderRateLimits> {
  const config = validateModelConfig();

  // Get rate limit values from environment or use defaults
  const maxConcurrentRequests = getEnvInt('MAX_CONCURRENT_REQUESTS', 30);
  const requestsPerMinute = getEnvInt('REQUESTS_PER_MINUTE', 60);
  const tokensPerMinute = getEnvInt('TOKENS_PER_MINUTE', 150000);

  // Provider-specific rate limits
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
 * Helper function to get integer value from environment variables
 * @param envVar The environment variable name
 * @param defaultValue The default value if not present
 * @returns The parsed integer value
 */
function getEnvInt(envVar: string, defaultValue: number): number {
  return process.env[envVar] ? parseInt(process.env[envVar]!, 10) : defaultValue;
}
