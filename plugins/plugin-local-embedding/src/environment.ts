import { logger } from "@elizaos/core";
import { z } from "zod";

// Default model filenames
const DEFAULT_EMBEDDING_MODEL = "bge-small-en-v1.5.Q4_K_M.gguf";

// Configuration schema focused only on local AI settings
/**
 * Configuration schema for local AI settings.
 * Allows overriding default model filenames via environment variables.
 */
export const configSchema = z.object({
  LOCAL_EMBEDDING_MODEL: z.string().optional().default(DEFAULT_EMBEDDING_MODEL),
  LOCAL_EMBEDDING_MODEL_REPO: z.string().optional(),
  MODELS_DIR: z.string().optional(), // Path for the models directory
  CACHE_DIR: z.string().optional(), // Path for the cache directory
  LOCAL_EMBEDDING_DIMENSIONS: z
    .string()
    .optional()
    .transform((val) => {
      if (!val?.trim()) return undefined;
      const parsed = Number.parseInt(val, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }),
  LOCAL_EMBEDDING_CONTEXT_SIZE: z
    .string()
    .optional()
    .transform((val) => {
      if (!val?.trim()) return undefined;
      const parsed = Number.parseInt(val, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }),
  LOCAL_EMBEDDING_GPU_LAYERS: z
    .string()
    .optional()
    .default("0")
    .transform((val) => {
      if (val === "auto") return -1; // -1 signals "auto" to our logic
      const num = parseInt(val, 10);
      return Number.isNaN(num) ? 0 : num;
    }),
  LOCAL_EMBEDDING_USE_MMAP: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true"),
  LOCAL_EMBEDDING_FORCE_CPU: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
});

/**
 * Export type representing the inferred type of the 'configSchema'.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Validates and parses the configuration, reading from environment variables.
 * Since only local AI is supported, this primarily ensures the structure
 * and applies defaults or environment variable overrides for model filenames.
 * @returns {Config} The validated configuration object.
 */
export function validateConfig(): Config {
  try {
    // Prepare the config for parsing, reading from process.env
    const configToParse = {
      LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
      LOCAL_EMBEDDING_MODEL_REPO: process.env.LOCAL_EMBEDDING_MODEL_REPO,
      MODELS_DIR: process.env.MODELS_DIR, // Read models directory path from env
      CACHE_DIR: process.env.CACHE_DIR, // Read cache directory path from env
      LOCAL_EMBEDDING_DIMENSIONS: process.env.LOCAL_EMBEDDING_DIMENSIONS, // Read embedding dimensions
      LOCAL_EMBEDDING_CONTEXT_SIZE: process.env.LOCAL_EMBEDDING_CONTEXT_SIZE,
      LOCAL_EMBEDDING_GPU_LAYERS: process.env.LOCAL_EMBEDDING_GPU_LAYERS,
      LOCAL_EMBEDDING_USE_MMAP: process.env.LOCAL_EMBEDDING_USE_MMAP,
      LOCAL_EMBEDDING_FORCE_CPU: process.env.LOCAL_EMBEDDING_FORCE_CPU,
    };

    logger.debug(
      {
        LOCAL_EMBEDDING_MODEL: configToParse.LOCAL_EMBEDDING_MODEL,
        LOCAL_EMBEDDING_MODEL_REPO: configToParse.LOCAL_EMBEDDING_MODEL_REPO,
        MODELS_DIR: configToParse.MODELS_DIR,
        CACHE_DIR: configToParse.CACHE_DIR,
        LOCAL_EMBEDDING_DIMENSIONS: configToParse.LOCAL_EMBEDDING_DIMENSIONS,
        LOCAL_EMBEDDING_CONTEXT_SIZE: configToParse.LOCAL_EMBEDDING_CONTEXT_SIZE,
        LOCAL_EMBEDDING_GPU_LAYERS: configToParse.LOCAL_EMBEDDING_GPU_LAYERS,
        LOCAL_EMBEDDING_USE_MMAP: configToParse.LOCAL_EMBEDDING_USE_MMAP,
        LOCAL_EMBEDDING_FORCE_CPU: configToParse.LOCAL_EMBEDDING_FORCE_CPU,
      },
      "Validating configuration for local AI plugin from env:"
    );

    const validatedConfig = configSchema.parse(configToParse);

    logger.info(validatedConfig, "Using local AI configuration:");

    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      logger.error(errorMessages, "Zod validation failed:");
      throw new Error(`Configuration validation failed:\n${errorMessages}`);
    }
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      "Configuration validation failed:"
    );
    throw error;
  }
}
