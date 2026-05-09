// @ts-nocheck — pending migration: @huggingface/transformers 3->4
// (PreTrainedModel/Florence2 interface changes), @elizaos/core logger
// signature drift (structured-context overload removed), and
// GenerateTextParams.{modelType,runtime} field removal. Tracked separately.
import { logger } from "@elizaos/core";
import { z } from "zod";

const DEFAULT_SMALL_MODEL = "DeepHermes-3-Llama-3-3B-Preview-q4.gguf";
const DEFAULT_LARGE_MODEL = "DeepHermes-3-Llama-3-8B-q4.gguf";
const DEFAULT_EMBEDDING_MODEL = "bge-small-en-v1.5.Q4_K_M.gguf";

export const configSchema = z.object({
  LOCAL_SMALL_MODEL: z.string().optional().default(DEFAULT_SMALL_MODEL),
  LOCAL_LARGE_MODEL: z.string().optional().default(DEFAULT_LARGE_MODEL),
  LOCAL_EMBEDDING_MODEL: z.string().optional().default(DEFAULT_EMBEDDING_MODEL),
  MODELS_DIR: z.string().optional(),
  CACHE_DIR: z.string().optional(),
  LOCAL_EMBEDDING_DIMENSIONS: z
    .string()
    .optional()
    .default("384")
    .transform((val) => parseInt(val, 10)),
});

export type Config = z.infer<typeof configSchema>;

export function validateConfig(): Config {
  try {
    const configToParse = {
      LOCAL_SMALL_MODEL: process.env.LOCAL_SMALL_MODEL,
      LOCAL_LARGE_MODEL: process.env.LOCAL_LARGE_MODEL,
      LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
      MODELS_DIR: process.env.MODELS_DIR,
      CACHE_DIR: process.env.CACHE_DIR,
      LOCAL_EMBEDDING_DIMENSIONS: process.env.LOCAL_EMBEDDING_DIMENSIONS,
    };

    logger.debug(
      {
        LOCAL_SMALL_MODEL: configToParse.LOCAL_SMALL_MODEL,
        LOCAL_LARGE_MODEL: configToParse.LOCAL_LARGE_MODEL,
        LOCAL_EMBEDDING_MODEL: configToParse.LOCAL_EMBEDDING_MODEL,
        MODELS_DIR: configToParse.MODELS_DIR,
        CACHE_DIR: configToParse.CACHE_DIR,
        LOCAL_EMBEDDING_DIMENSIONS: configToParse.LOCAL_EMBEDDING_DIMENSIONS,
      },
      "Validating configuration for local AI plugin from env:"
    );

    const validatedConfig = configSchema.parse(configToParse);

    logger.info(validatedConfig as Record<string, unknown>, "Using local AI configuration:");

    return validatedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      logger.error(`Zod validation failed: ${errorMessages}`);
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
