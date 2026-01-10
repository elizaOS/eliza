/**
 * @dexploarer/plugin-gateway
 *
 * Unified AI gateway for ElizaOS using Vercel AI SDK and OpenRouter.
 * Provides model handlers for text generation, embeddings, and images
 * across all major AI providers.
 *
 * @example
 * ```typescript
 * import { gatewayPlugin } from '@dexploarer/plugin-gateway';
 *
 * const agent = {
 *   plugins: [gatewayPlugin],
 *   settings: {
 *     secrets: {
 *       OPENROUTER_API_KEY: "your-key",
 *       // Or individual provider keys:
 *       OPENAI_API_KEY: "...",
 *       ANTHROPIC_API_KEY: "...",
 *     },
 *   },
 * };
 * ```
 */

import type { Plugin, IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  generateTextWithOpenRouter,
  generateEmbeddingWithOpenRouter,
  generateImageWithOpenRouter,
  OPENROUTER_MODELS,
} from "./providers/openrouter";
import {
  generateTextWithVercel,
  generateEmbeddingWithVercel,
} from "./providers/vercel-ai";
import {
  generateTextWithVercelGateway,
  generateEmbeddingWithVercelGateway,
  generateImageWithVercelGateway,
  VERCEL_GATEWAY_MODELS,
} from "./providers/vercel-gateway";
import type { GatewayConfig, ModelProviderName } from "./types";
import { PROVIDER_MODELS, ENV_KEYS } from "./types";

// Re-export types and utilities
export * from "./types";
export * from "./providers";

/**
 * Default gateway configuration
 * Uses Vercel AI Gateway by default (zero markup, recommended)
 */
const DEFAULT_CONFIG: GatewayConfig = {
  defaultTextProvider: "vercel-gateway",
  defaultEmbeddingProvider: "vercel-gateway",
  defaultImageProvider: "vercel-gateway",
  models: {
    textLarge: "openai/gpt-oss-120b",  // GPT OSS 120B via Vercel AI Gateway (Cerebras-powered)
    textSmall: "openai/gpt-oss-120b",  // Same model - ultra-fast inference
    embedding: "openai/text-embedding-3-small", // OpenAI embeddings via Vercel AI Gateway
    image: "google/imagen-3.0-generate-001", // Google Imagen via Vercel AI Gateway
  },
};

/**
 * Get gateway config from runtime settings
 */
function getGatewayConfig(runtime: IAgentRuntime): GatewayConfig {
  const customConfig = runtime.getSetting("GATEWAY_CONFIG") as
    | Partial<GatewayConfig>
    | undefined;
  return { ...DEFAULT_CONFIG, ...customConfig };
}

/**
 * Determine which provider to use based on config and available keys
 */
function resolveProvider(
  runtime: IAgentRuntime,
  preferredProvider: ModelProviderName
): ModelProviderName {
  // Check if preferred provider has a key
  const envKey = ENV_KEYS[preferredProvider];
  const hasKey =
    runtime.getSetting(envKey) || process.env[envKey];

  if (hasKey) return preferredProvider;

  // Fallback to Vercel AI Gateway if available (zero markup, recommended)
  if (
    runtime.getSetting("AI_GATEWAY_API_KEY") ||
    process.env.AI_GATEWAY_API_KEY
  ) {
    return "vercel-gateway";
  }

  // Fallback to OpenRouter if available
  if (
    runtime.getSetting("OPENROUTER_API_KEY") ||
    process.env.OPENROUTER_API_KEY
  ) {
    return "openrouter";
  }

  // Try other providers
  for (const provider of Object.keys(ENV_KEYS) as ModelProviderName[]) {
    const key = ENV_KEYS[provider];
    if (runtime.getSetting(key) || process.env[key]) {
      return provider;
    }
  }

  return preferredProvider; // Will fail with missing key error
}

/**
 * TEXT_LARGE model handler
 * Uses the configured large text model (default: claude-sonnet-4 via OpenRouter)
 */
async function handleTextLarge(
  runtime: IAgentRuntime,
  params: {
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    stopSequences?: string[];
  }
): Promise<string> {
  const config = getGatewayConfig(runtime);
  const provider = resolveProvider(runtime, config.defaultTextProvider);
  const model = config.models.textLarge || "claude-sonnet-4";

  const textParams = {
    prompt: params.prompt,
    system: params.system,
    maxTokens: params.maxTokens || 8192,
    temperature: params.temperature || 0.7,
    stopSequences: params.stopSequences,
  };

  if (provider === "vercel-gateway") {
    return generateTextWithVercelGateway(runtime, model, textParams);
  }

  if (provider === "openrouter") {
    return generateTextWithOpenRouter(runtime, model, textParams);
  }

  return generateTextWithVercel(runtime, provider, "textLarge", textParams);
}

/**
 * TEXT_SMALL model handler
 * Uses the configured small text model (default: gpt-4o-mini via OpenRouter)
 */
async function handleTextSmall(
  runtime: IAgentRuntime,
  params: {
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    stopSequences?: string[];
  }
): Promise<string> {
  const config = getGatewayConfig(runtime);
  const provider = resolveProvider(runtime, config.defaultTextProvider);
  const model = config.models.textSmall || "gpt-4o-mini";

  const textParams = {
    prompt: params.prompt,
    system: params.system,
    maxTokens: params.maxTokens || 4096,
    temperature: params.temperature || 0.7,
    stopSequences: params.stopSequences,
  };

  if (provider === "vercel-gateway") {
    return generateTextWithVercelGateway(runtime, model, textParams);
  }

  if (provider === "openrouter") {
    return generateTextWithOpenRouter(runtime, model, textParams);
  }

  return generateTextWithVercel(runtime, provider, "textSmall", textParams);
}

/**
 * TEXT_EMBEDDING model handler
 * Uses the configured embedding model (default: text-embedding-3-small via OpenRouter)
 */
async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: { text: string } | null
): Promise<number[]> {
  // Handle null params (called during initialization to check embedding dimension)
  const text = params?.text || "test";

  const config = getGatewayConfig(runtime);
  const provider = resolveProvider(runtime, config.defaultEmbeddingProvider);
  const model = config.models.embedding || "text-embedding-3-small";

  if (provider === "vercel-gateway") {
    return generateEmbeddingWithVercelGateway(runtime, model, { text });
  }

  if (provider === "openrouter") {
    return generateEmbeddingWithOpenRouter(runtime, model, { text });
  }

  return generateEmbeddingWithVercel(runtime, provider, { text });
}

/**
 * IMAGE model handler
 * Uses the configured image model (default: Google Imagen 3 via gateway)
 */
async function handleImage(
  runtime: IAgentRuntime,
  params: {
    prompt: string;
    size?: string;
    quality?: string;
    n?: number;
  }
): Promise<string> {
  const config = getGatewayConfig(runtime);
  const provider = resolveProvider(runtime, config.defaultImageProvider);
  const model = config.models.image || "imagen-3";

  const imageOptions = {
    size: params.size,
    quality: params.quality,
    n: params.n,
  };

  if (provider === "vercel-gateway") {
    return generateImageWithVercelGateway(runtime, model, params.prompt, imageOptions);
  }

  return generateImageWithOpenRouter(runtime, model, params.prompt, imageOptions);
}

/**
 * Hyperscape Gateway Plugin
 *
 * Provides unified AI model access through Vercel AI Gateway, OpenRouter,
 * and direct Vercel AI SDK integration. Supports 200+ models across all major providers.
 *
 * Supported model types:
 * - TEXT_LARGE: Large language models (Claude, GPT-4, Gemini, Llama)
 * - TEXT_SMALL: Fast, efficient models (GPT-4o-mini, Haiku, Gemini Flash)
 * - TEXT_EMBEDDING: Text embeddings (OpenAI, Cohere)
 * - IMAGE: Image generation (Google Imagen, DALL-E, FLUX)
 *
 * Configuration via runtime settings:
 * - AI_GATEWAY_API_KEY: Vercel AI Gateway key (recommended - zero markup)
 * - OPENROUTER_API_KEY: OpenRouter API key (single key for all providers)
 * - GATEWAY_CONFIG: Custom gateway configuration object
 * - Individual provider keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
 */
export const gatewayPlugin: Plugin = {
  name: "@dexploarer/plugin-gateway",
  description:
    "Unified AI gateway using Vercel AI SDK and OpenRouter for 200+ models",

  // Register model handlers
  models: {
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [ModelType.TEXT_SMALL]: handleTextSmall,
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
    [ModelType.IMAGE]: handleImage,
  },

  // No actions needed
  actions: [],

  // No providers needed
  providers: [],

  // No evaluators needed
  evaluators: [],

  // No services needed
  services: [],

  // No events needed
  events: {},
};

// Default export
export default gatewayPlugin;

// Re-export model mappings for convenience
export { OPENROUTER_MODELS, VERCEL_GATEWAY_MODELS, PROVIDER_MODELS, ENV_KEYS };
