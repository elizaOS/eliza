import { ModelConfig, ModelConfigSchema, ProviderRateLimits } from './types.ts';
import z from 'zod';
import { logger, IAgentRuntime } from '@elizaos/core';

const parseBooleanEnv = (value: any): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false; // Default to false if undefined or other type
};

/**
 * Validates the model configuration using runtime settings
 * @param runtime The agent runtime to get settings from
 * @returns The validated configuration or throws an error
 */
export function validateModelConfig(runtime?: IAgentRuntime): ModelConfig {
  try {
    // Helper function to get setting from runtime or fallback to process.env
    const getSetting = (key: string, defaultValue?: string) => {
      if (runtime) {
        return runtime.getSetting(key) || process.env[key] || defaultValue;
      }
      return process.env[key] || defaultValue;
    };

    // Determine if contextual Knowledge is enabled
    const ctxKnowledgeEnabled = parseBooleanEnv(getSetting('CTX_KNOWLEDGE_ENABLED', 'false'));

    // Log configuration once during validation (not per chunk)
    logger.debug(
      `[Document Processor] CTX_KNOWLEDGE_ENABLED: '${ctxKnowledgeEnabled} (runtime: ${!!runtime})`
    );

    // If EMBEDDING_PROVIDER is not provided, assume we're using plugin-openai
    const embeddingProvider = getSetting('EMBEDDING_PROVIDER');
    const assumePluginOpenAI = !embeddingProvider;

    if (assumePluginOpenAI) {
      const openaiApiKey = getSetting('OPENAI_API_KEY');
      const openaiEmbeddingModel = getSetting('OPENAI_EMBEDDING_MODEL');

      if (openaiApiKey && openaiEmbeddingModel) {
        logger.debug(
          '[Document Processor] EMBEDDING_PROVIDER not specified, using configuration from plugin-openai'
        );
      } else {
        logger.debug(
          '[Document Processor] EMBEDDING_PROVIDER not specified. Assuming embeddings are provided by another plugin (e.g., plugin-google-genai).'
        );
      }
    }

    // Only set embedding provider if explicitly configured
    // If not set, let the runtime handle embeddings (e.g., plugin-google-genai)
    const finalEmbeddingProvider = embeddingProvider;

    const textEmbeddingModel =
      getSetting('TEXT_EMBEDDING_MODEL') ||
      getSetting('OPENAI_EMBEDDING_MODEL') ||
      'text-embedding-3-small';
    const embeddingDimension =
      getSetting('EMBEDDING_DIMENSION') || getSetting('OPENAI_EMBEDDING_DIMENSIONS') || '1536';

    // Use OpenAI API key from runtime settings
    const openaiApiKey = getSetting('OPENAI_API_KEY');

    const config = ModelConfigSchema.parse({
      EMBEDDING_PROVIDER: finalEmbeddingProvider,
      TEXT_PROVIDER: getSetting('TEXT_PROVIDER'),

      OPENAI_API_KEY: openaiApiKey,
      ANTHROPIC_API_KEY: getSetting('ANTHROPIC_API_KEY'),
      OPENROUTER_API_KEY: getSetting('OPENROUTER_API_KEY'),
      GOOGLE_API_KEY: getSetting('GOOGLE_API_KEY'),

      OPENAI_BASE_URL: getSetting('OPENAI_BASE_URL'),
      ANTHROPIC_BASE_URL: getSetting('ANTHROPIC_BASE_URL'),
      OPENROUTER_BASE_URL: getSetting('OPENROUTER_BASE_URL'),
      GOOGLE_BASE_URL: getSetting('GOOGLE_BASE_URL'),

      TEXT_EMBEDDING_MODEL: textEmbeddingModel,
      TEXT_MODEL: getSetting('TEXT_MODEL'),

      MAX_INPUT_TOKENS: getSetting('MAX_INPUT_TOKENS', '4000'),
      MAX_OUTPUT_TOKENS: getSetting('MAX_OUTPUT_TOKENS', '4096'),

      EMBEDDING_DIMENSION: embeddingDimension,

      LOAD_DOCS_ON_STARTUP: parseBooleanEnv(getSetting('LOAD_DOCS_ON_STARTUP')),
      CTX_KNOWLEDGE_ENABLED: ctxKnowledgeEnabled,

      // Rate limiting settings - optimized for batch embeddings
      // With batch embeddings, we send 100 texts in ONE API call
      // 935 chunks / 100 = ~10 API calls instead of 935!
      RATE_LIMIT_ENABLED: parseBooleanEnv(getSetting('RATE_LIMIT_ENABLED', 'true')),
      MAX_CONCURRENT_REQUESTS: getSetting('MAX_CONCURRENT_REQUESTS', '100'),
      REQUESTS_PER_MINUTE: getSetting('REQUESTS_PER_MINUTE', '500'),
      TOKENS_PER_MINUTE: getSetting('TOKENS_PER_MINUTE', '1000000'),
      BATCH_DELAY_MS: getSetting('BATCH_DELAY_MS', '100'),
    });
    validateConfigRequirements(config, assumePluginOpenAI);
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
 * @param assumePluginOpenAI Whether we're assuming plugin-openai is being used
 * @throws Error if a required configuration value is missing
 */
function validateConfigRequirements(config: ModelConfig, assumePluginOpenAI: boolean): void {
  // Only validate embedding requirements if EMBEDDING_PROVIDER is explicitly set
  const embeddingProvider = config.EMBEDDING_PROVIDER;

  // If EMBEDDING_PROVIDER is explicitly set, validate its requirements
  if (embeddingProvider === 'openai' && !config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER is set to "openai"');
  }
  if (embeddingProvider === 'google' && !config.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is required when EMBEDDING_PROVIDER is set to "google"');
  }

  // If no embedding provider is set, skip validation - let runtime handle it
  if (!embeddingProvider) {
    logger.debug(
      '[Document Processor] No EMBEDDING_PROVIDER specified. Embeddings will be handled by the runtime.'
    );
  }

  // If we're assuming plugin-openai AND user has OpenAI configuration, validate it
  // But don't fail if they're using a different embedding provider (e.g. google-genai)
  if (assumePluginOpenAI && config.OPENAI_API_KEY && !config.TEXT_EMBEDDING_MODEL) {
    throw new Error('OPENAI_EMBEDDING_MODEL is required when using plugin-openai configuration');
  }

  // If Contextual Knowledge is enabled, we need additional validations
  if (config.CTX_KNOWLEDGE_ENABLED) {
    // Only log validation once during config init (not per document)
    logger.debug('[Document Processor] CTX validation: Checking text generation settings...');

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
        logger.debug(
          `[Document Processor] Using ${modelName} with OpenRouter. This configuration supports document caching for improved performance.`
        );
      }
    }
  } else {
    // Log appropriate message based on where embedding config came from
    logger.info('[Document Processor] Contextual Knowledge is DISABLED!');
    logger.info('[Document Processor] This means documents will NOT be enriched with context.');
    if (assumePluginOpenAI) {
      logger.info(
        '[Document Processor] Embeddings will be handled by the runtime (e.g., plugin-openai, plugin-google-genai).'
      );
    } else {
      logger.info(
        '[Document Processor] Using configured embedding provider for basic embeddings only.'
      );
    }
  }
}

/**
 * Returns rate limit information for the configured providers
 * Checks BOTH TEXT_PROVIDER (for LLM calls) and EMBEDDING_PROVIDER
 *
 * Set RATE_LIMIT_ENABLED=false to disable all rate limiting for fast uploads.
 * This is useful when using APIs without rate limits (e.g., self-hosted models).
 *
 * @param runtime The agent runtime to get settings from
 * @returns Rate limit configuration for the current providers
 */
export async function getProviderRateLimits(runtime?: IAgentRuntime): Promise<ProviderRateLimits> {
  const config = validateModelConfig(runtime);

  // Get rate limit values from validated config
  const rateLimitEnabled = config.RATE_LIMIT_ENABLED;
  const maxConcurrentRequests = config.MAX_CONCURRENT_REQUESTS;
  const requestsPerMinute = config.REQUESTS_PER_MINUTE;
  const tokensPerMinute = config.TOKENS_PER_MINUTE;
  const batchDelayMs = config.BATCH_DELAY_MS;

  // CRITICAL FIX: Check TEXT_PROVIDER first since that's where rate limits are typically hit
  const primaryProvider = config.TEXT_PROVIDER || config.EMBEDDING_PROVIDER;

  if (!rateLimitEnabled) {
    logger.info(
      `[Document Processor] Rate limiting DISABLED - unlimited throughput mode (concurrent: ${maxConcurrentRequests}, batch delay: ${batchDelayMs}ms)`
    );
    return {
      maxConcurrentRequests,
      requestsPerMinute: Number.MAX_SAFE_INTEGER,
      tokensPerMinute: Number.MAX_SAFE_INTEGER,
      provider: primaryProvider || 'unlimited',
      rateLimitEnabled: false,
      batchDelayMs,
    };
  }

  logger.debug(
    `[Document Processor] Rate limiting for ${primaryProvider}: ${requestsPerMinute} RPM, ${tokensPerMinute} TPM, ${maxConcurrentRequests} concurrent, ${batchDelayMs}ms batch delay`
  );

  // Use user-configured values directly - trust the user's gateway/API setup
  // No provider-specific caps to allow high-throughput setups (e.g., Vercel gateway)
  return {
    maxConcurrentRequests,
    requestsPerMinute,
    tokensPerMinute,
    provider: primaryProvider || 'unknown',
    rateLimitEnabled: true,
    batchDelayMs,
  };
}
