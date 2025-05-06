import { logger } from '@elizaos/core';
import { z } from 'zod';

// Default model filenames
const DEFAULT_SMALL_MODEL = 'DeepHermes-3-Llama-3-3B-Preview-q4.gguf';
const DEFAULT_LARGE_MODEL = 'DeepHermes-3-Llama-3-8B-q4.gguf';
const DEFAULT_EMBEDDING_MODEL = 'bge-small-en-v1.5.Q4_K_M.gguf';

// Configuration schema focused only on local AI settings
/**
 * Configuration schema for local AI settings.
 * Allows overriding default model filenames via environment variables.
 */
export const configSchema = z.object({
  LOCAL_SMALL_MODEL: z.string().optional().default(DEFAULT_SMALL_MODEL),
  LOCAL_LARGE_MODEL: z.string().optional().default(DEFAULT_LARGE_MODEL),
  LOCAL_EMBEDDING_MODEL: z.string().optional().default(DEFAULT_EMBEDDING_MODEL),
  MODELS_DIR: z.string().optional(), // Path for the models directory
  CACHE_DIR: z.string().optional(), // Path for the cache directory
  LOCAL_EMBEDDING_DIMENSIONS: z
    .string()
    .optional()
    .default('384') // Default to 384 if not provided
    .transform((val) => parseInt(val, 10)), // Transform to number
});

/**
 * Export type representing the inferred type of the 'configSchema'.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Validates and parses the configuration, reading from environment variables.
 * Since only local AI is supported, this primarily ensures the structure
 * and applies defaults or environment variable overrides for model filenames.
 * @returns {Promise<Config>} The validated configuration object.
 */
export async function validateConfig(): Promise<Config> {
  try {
    // Prepare the config for parsing, reading from process.env
    const configToParse = {
      // Read model filenames from environment variables or use undefined (so zod defaults apply)
      LOCAL_SMALL_MODEL: process.env.LOCAL_SMALL_MODEL,
      LOCAL_LARGE_MODEL: process.env.LOCAL_LARGE_MODEL,
      LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
      MODELS_DIR: process.env.MODELS_DIR, // Read models directory path from env
      CACHE_DIR: process.env.CACHE_DIR, // Read cache directory path from env
      LOCAL_EMBEDDING_DIMENSIONS: process.env.LOCAL_EMBEDDING_DIMENSIONS, // Read embedding dimensions
    };

    logger.debug('Validating configuration for local AI plugin from env:', {
      LOCAL_SMALL_MODEL: configToParse.LOCAL_SMALL_MODEL,
      LOCAL_LARGE_MODEL: configToParse.LOCAL_LARGE_MODEL,
      LOCAL_EMBEDDING_MODEL: configToParse.LOCAL_EMBEDDING_MODEL,
      MODELS_DIR: configToParse.MODELS_DIR,
      CACHE_DIR: configToParse.CACHE_DIR,
      LOCAL_EMBEDDING_DIMENSIONS: configToParse.LOCAL_EMBEDDING_DIMENSIONS,
    });

    const validatedConfig = configSchema.parse(configToParse);

    logger.info('Using local AI configuration:', validatedConfig);

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
