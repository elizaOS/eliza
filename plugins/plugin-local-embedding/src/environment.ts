import { logger } from "@elizaos/core";
import { z } from "zod";

const DEFAULT_EMBEDDING_MODEL = "text/eliza-1-lite-0_6b-32k.gguf";

/**
 * Configuration schema for the local embedding plugin.
 * Allows overriding default model filenames, hardware backend, batch
 * size, pooling, and chunk overlap via environment variables.
 */
export const configSchema = z.object({
  LOCAL_EMBEDDING_MODEL: z.string().optional().default(DEFAULT_EMBEDDING_MODEL),
  LOCAL_EMBEDDING_MODEL_REPO: z.string().optional(),
  MODELS_DIR: z.string().optional(),
  CACHE_DIR: z.string().optional(),
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
      if (val === "auto") return -1;
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
  LOCAL_EMBEDDING_BATCH_SIZE: z
    .string()
    .optional()
    .transform((val) => {
      if (!val?.trim()) return undefined;
      const parsed = Number.parseInt(val, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }),
  LOCAL_EMBEDDING_CHUNK_OVERLAP: z
    .string()
    .optional()
    .transform((val) => {
      if (!val?.trim()) return undefined;
      const parsed = Number.parseInt(val, 10);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    }),
  LOCAL_EMBEDDING_POOLING: z.string().optional(),
  LOCAL_EMBEDDING_NORMALIZE: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),
});

export type Config = z.infer<typeof configSchema>;

export function validateConfig(): Config {
  try {
    const configToParse = {
      LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
      LOCAL_EMBEDDING_MODEL_REPO: process.env.LOCAL_EMBEDDING_MODEL_REPO,
      MODELS_DIR: process.env.MODELS_DIR,
      CACHE_DIR: process.env.CACHE_DIR,
      LOCAL_EMBEDDING_DIMENSIONS: process.env.LOCAL_EMBEDDING_DIMENSIONS,
      LOCAL_EMBEDDING_CONTEXT_SIZE: process.env.LOCAL_EMBEDDING_CONTEXT_SIZE,
      LOCAL_EMBEDDING_GPU_LAYERS: process.env.LOCAL_EMBEDDING_GPU_LAYERS,
      LOCAL_EMBEDDING_USE_MMAP: process.env.LOCAL_EMBEDDING_USE_MMAP,
      LOCAL_EMBEDDING_FORCE_CPU: process.env.LOCAL_EMBEDDING_FORCE_CPU,
      LOCAL_EMBEDDING_BATCH_SIZE: process.env.LOCAL_EMBEDDING_BATCH_SIZE,
      LOCAL_EMBEDDING_CHUNK_OVERLAP: process.env.LOCAL_EMBEDDING_CHUNK_OVERLAP,
      LOCAL_EMBEDDING_POOLING: process.env.LOCAL_EMBEDDING_POOLING,
      LOCAL_EMBEDDING_NORMALIZE: process.env.LOCAL_EMBEDDING_NORMALIZE,
    };

    logger.debug(configToParse, "Validating local embedding plugin config from env");

    const validatedConfig = configSchema.parse(configToParse);

    logger.info(validatedConfig, "Using local embedding configuration");

    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      logger.error(errorMessages, "Zod validation failed for local embedding config:");
      throw new Error(`Configuration validation failed:\n${errorMessages}`);
    }
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      "Configuration validation failed"
    );
    throw error;
  }
}
