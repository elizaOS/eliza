import type { IAgentRuntime } from "@elizaos/core";
import z from "zod";
import { type ModelConfig, ModelConfigSchema, type ProviderRateLimits } from "./types.ts";

const parseBooleanEnv = (value: string | boolean | number | undefined): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
};

export function validateModelConfig(runtime?: IAgentRuntime): ModelConfig {
  try {
    const getSetting = (key: string, defaultValue?: string) => {
      if (runtime) {
        return runtime.getSetting(key) || process.env[key] || defaultValue;
      }
      return process.env[key] || defaultValue;
    };

    const ctxKnowledgeEnabled = parseBooleanEnv(getSetting("CTX_KNOWLEDGE_ENABLED", "false"));
    const embeddingProvider = getSetting("EMBEDDING_PROVIDER");
    const assumePluginOpenAI = !embeddingProvider;

    const textEmbeddingModel =
      getSetting("TEXT_EMBEDDING_MODEL") ||
      getSetting("OPENAI_EMBEDDING_MODEL") ||
      "text-embedding-3-small";
    const embeddingDimension =
      getSetting("EMBEDDING_DIMENSION") || getSetting("OPENAI_EMBEDDING_DIMENSIONS") || "1536";

    const openaiApiKey = getSetting("OPENAI_API_KEY");

    const config = ModelConfigSchema.parse({
      EMBEDDING_PROVIDER: embeddingProvider,
      TEXT_PROVIDER: getSetting("TEXT_PROVIDER"),

      OPENAI_API_KEY: openaiApiKey,
      ANTHROPIC_API_KEY: getSetting("ANTHROPIC_API_KEY"),
      OPENROUTER_API_KEY: getSetting("OPENROUTER_API_KEY"),
      GOOGLE_API_KEY: getSetting("GOOGLE_API_KEY"),

      OPENAI_BASE_URL: getSetting("OPENAI_BASE_URL"),
      ANTHROPIC_BASE_URL: getSetting("ANTHROPIC_BASE_URL"),
      OPENROUTER_BASE_URL: getSetting("OPENROUTER_BASE_URL"),
      GOOGLE_BASE_URL: getSetting("GOOGLE_BASE_URL"),

      TEXT_EMBEDDING_MODEL: textEmbeddingModel,
      TEXT_MODEL: getSetting("TEXT_MODEL"),

      MAX_INPUT_TOKENS: getSetting("MAX_INPUT_TOKENS", "4000"),
      MAX_OUTPUT_TOKENS: getSetting("MAX_OUTPUT_TOKENS", "4096"),

      EMBEDDING_DIMENSION: embeddingDimension,

      LOAD_DOCS_ON_STARTUP: parseBooleanEnv(getSetting("LOAD_DOCS_ON_STARTUP")),
      CTX_KNOWLEDGE_ENABLED: ctxKnowledgeEnabled,

      RATE_LIMIT_ENABLED: parseBooleanEnv(getSetting("RATE_LIMIT_ENABLED", "true")),
      MAX_CONCURRENT_REQUESTS: getSetting("MAX_CONCURRENT_REQUESTS", "100"),
      REQUESTS_PER_MINUTE: getSetting("REQUESTS_PER_MINUTE", "500"),
      TOKENS_PER_MINUTE: getSetting("TOKENS_PER_MINUTE", "1000000"),
      BATCH_DELAY_MS: getSetting("BATCH_DELAY_MS", "100"),
    });
    validateConfigRequirements(config, assumePluginOpenAI);
    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ");
      throw new Error(`Model configuration validation failed: ${issues}`);
    }
    throw error;
  }
}

function validateConfigRequirements(config: ModelConfig, assumePluginOpenAI: boolean): void {
  const embeddingProvider = config.EMBEDDING_PROVIDER;

  if (embeddingProvider === "openai" && !config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER is set to "openai"');
  }
  if (embeddingProvider === "google" && !config.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is required when EMBEDDING_PROVIDER is set to "google"');
  }

  if (assumePluginOpenAI && config.OPENAI_API_KEY && !config.TEXT_EMBEDDING_MODEL) {
    throw new Error("OPENAI_EMBEDDING_MODEL is required when using plugin-openai configuration");
  }

  if (config.CTX_KNOWLEDGE_ENABLED) {
    if (config.TEXT_PROVIDER === "openai" && !config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when TEXT_PROVIDER is set to "openai"');
    }
    if (config.TEXT_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required when TEXT_PROVIDER is set to "anthropic"');
    }
    if (config.TEXT_PROVIDER === "openrouter" && !config.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required when TEXT_PROVIDER is set to "openrouter"');
    }
    if (config.TEXT_PROVIDER === "google" && !config.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when TEXT_PROVIDER is set to "google"');
    }
  }
}

export async function getProviderRateLimits(runtime?: IAgentRuntime): Promise<ProviderRateLimits> {
  const config = validateModelConfig(runtime);

  const rateLimitEnabled = config.RATE_LIMIT_ENABLED;
  const maxConcurrentRequests = config.MAX_CONCURRENT_REQUESTS;
  const requestsPerMinute = config.REQUESTS_PER_MINUTE;
  const tokensPerMinute = config.TOKENS_PER_MINUTE;
  const batchDelayMs = config.BATCH_DELAY_MS;

  const primaryProvider = config.TEXT_PROVIDER || config.EMBEDDING_PROVIDER;

  if (!rateLimitEnabled) {
    return {
      maxConcurrentRequests,
      requestsPerMinute: Number.MAX_SAFE_INTEGER,
      tokensPerMinute: Number.MAX_SAFE_INTEGER,
      provider: primaryProvider || "unlimited",
      rateLimitEnabled: false,
      batchDelayMs,
    };
  }

  return {
    maxConcurrentRequests,
    requestsPerMinute,
    tokensPerMinute,
    provider: primaryProvider || "unlimited",
    rateLimitEnabled: true,
    batchDelayMs,
  };
}
