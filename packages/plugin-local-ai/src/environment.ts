import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { z } from 'zod';

// Configuration schema with text model source flags
/**
 * Configuration schema for different AI models and their settings.
 * This schema includes:
 * - Flags for enabling/disabling various AI models
 * - Ollama configurations including server URL, models, and embedding models
 * - StudioLM configurations including server URL, models, and embedding models
 */
export const configSchema = z.object({
  USE_LOCAL_AI: z.boolean().default(true),
  USE_STUDIOLM_TEXT_MODELS: z.boolean().default(false),
  USE_OLLAMA_TEXT_MODELS: z.boolean().default(false),

  // Ollama Configuration
  OLLAMA_SERVER_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('deepseek-r1-distill-qwen-7b'),
  USE_OLLAMA_EMBEDDING: z.boolean().default(false),
  OLLAMA_EMBEDDING_MODEL: z.string().default(''),
  SMALL_OLLAMA_MODEL: z.string().default('deepseek-r1:1.5b'),
  MEDIUM_OLLAMA_MODEL: z.string().default('deepseek-r1:7b'),
  LARGE_OLLAMA_MODEL: z.string().default('deepseek-r1:7b'),

  // StudioLM Configuration
  STUDIOLM_SERVER_URL: z.string().default('http://localhost:1234'),
  STUDIOLM_SMALL_MODEL: z.string().default('lmstudio-community/deepseek-r1-distill-qwen-1.5b'),
  STUDIOLM_MEDIUM_MODEL: z.string().default('deepseek-r1-distill-qwen-7b'),
  STUDIOLM_EMBEDDING_MODEL: z.union([z.boolean(), z.string()]).default(false),
});

/**
 * Export type representing the inferred type of the 'configSchema'.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Validates the model configuration object.
 *
 * @param {Record<string, boolean>} config - The model configuration object containing boolean values.
 * @returns {void}
 */
function validateModelConfig(config: Record<string, boolean>): void {
  // Log raw values before validation
  logger.info('Validating model configuration with values:', {
    USE_LOCAL_AI: config.USE_LOCAL_AI,
    USE_STUDIOLM_TEXT_MODELS: config.USE_STUDIOLM_TEXT_MODELS,
    USE_OLLAMA_TEXT_MODELS: config.USE_OLLAMA_TEXT_MODELS,
  });

  // Ensure USE_LOCAL_AI is always true
  if (!config.USE_LOCAL_AI) {
    config.USE_LOCAL_AI = true;
    logger.info("Setting USE_LOCAL_AI to true as it's required");
  }

  // Only validate that StudioLM and Ollama are not both enabled
  if (config.USE_STUDIOLM_TEXT_MODELS && config.USE_OLLAMA_TEXT_MODELS) {
    throw new Error('StudioLM and Ollama text models cannot be enabled simultaneously');
  }

  logger.info('Configuration is valid');
}

/**
 * Validates and parses the configuration provided as a record of string key-value pairs.
 * This function performs boolean conversion on specific configuration values and sets default values for missing keys.
 * @param {Record<string, string>} config - The configuration to validate and parse.
 * @returns {Promise<Config>} The validated and parsed configuration object.
 */
export async function validateConfig(config: Record<string, string>): Promise<Config> {
  try {
    // Log raw environment variables
    // logger.info("Raw environment variables:", {
    //     USE_LOCAL_AI: process.env.USE_LOCAL_AI,
    //     USE_STUDIOLM_TEXT_MODELS: process.env.USE_STUDIOLM_TEXT_MODELS,
    //     USE_OLLAMA_TEXT_MODELS: process.env.USE_OLLAMA_TEXT_MODELS,
    //     OLLAMA_SERVER_URL: process.env.OLLAMA_SERVER_URL,
    //     STUDIOLM_SERVER_URL: process.env.STUDIOLM_SERVER_URL
    // });

    // Parse environment variables with proper boolean conversion
    const booleanConfig = {
      USE_LOCAL_AI: true, // Always true
      USE_STUDIOLM_TEXT_MODELS: config.USE_STUDIOLM_TEXT_MODELS === 'true',
      USE_OLLAMA_TEXT_MODELS: config.USE_OLLAMA_TEXT_MODELS === 'true',
      USE_OLLAMA_EMBEDDING: config.USE_OLLAMA_EMBEDDING === 'true',
    };

    // logger.info("Parsed boolean configuration:", booleanConfig);

    // Validate text model source configuration
    validateModelConfig(booleanConfig);

    // Create full config with all values
    const fullConfig = {
      ...booleanConfig,
      OLLAMA_SERVER_URL: config.OLLAMA_SERVER_URL || 'http://localhost:11434',
      OLLAMA_MODEL: config.OLLAMA_MODEL || 'deepseek-r1-distill-qwen-7b',
      OLLAMA_EMBEDDING_MODEL: config.OLLAMA_EMBEDDING_MODEL || '',
      SMALL_OLLAMA_MODEL: config.SMALL_OLLAMA_MODEL || 'deepseek-r1:1.5b',
      MEDIUM_OLLAMA_MODEL: config.MEDIUM_OLLAMA_MODEL || 'deepseek-r1:7b',
      LARGE_OLLAMA_MODEL: config.LARGE_OLLAMA_MODEL || 'deepseek-r1:7b',
      STUDIOLM_SERVER_URL: config.STUDIOLM_SERVER_URL || 'http://localhost:1234',
      STUDIOLM_SMALL_MODEL:
        config.STUDIOLM_SMALL_MODEL || 'lmstudio-community/deepseek-r1-distill-qwen-1.5b',
      STUDIOLM_MEDIUM_MODEL: config.STUDIOLM_MEDIUM_MODEL || 'deepseek-r1-distill-qwen-7b',
      STUDIOLM_EMBEDDING_MODEL: config.STUDIOLM_EMBEDDING_MODEL || false,
    };

    const validatedConfig = configSchema.parse(fullConfig);

    // logger.info("Final validated configuration:", validatedConfig);

    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      logger.error('Zod validation failed:', errorMessages);
      throw new Error(`Configuration validation failed:\n${errorMessages}`);
    }
    logger.error('Configuration validation failed:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
