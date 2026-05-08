/**
 * Model Tiers Configuration
 *
 * Single source of truth for all model tier mappings.
 * Provides abstraction between user-friendly tier names and actual model IDs.
 *
 * Environment variables can override default model IDs:
 * - MODEL_TIER_FAST_ID
 * - MODEL_TIER_PRO_ID
 * - MODEL_TIER_ULTRA_ID
 */

import {
  expandOpenRouterModelIdCandidates,
  normalizeProviderKey,
} from "@/lib/providers/model-id-translation";
import {
  OPENROUTER_DEFAULT_FREE_MODEL,
  OPENROUTER_DEFAULT_TEXT_MODEL,
  OPENROUTER_RECOMMENDED_TEXT_MODEL,
} from "./catalog";

export type ModelTier = "fast" | "pro" | "ultra";

export type ModelCapability =
  | "text"
  | "code"
  | "reasoning"
  | "vision"
  | "function_calling"
  | "long_context";

export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
  currency: "USD";
}

export interface ModelTierConfig {
  id: ModelTier;
  name: string;
  description: string;
  modelId: string;
  provider: string;
  icon: "zap" | "sparkles" | "crown";
  pricing: ModelPricing;
  capabilities: ModelCapability[];
  contextWindow: number;
  recommended?: boolean;
}

function getEnvModelId(tier: ModelTier, defaultId: string): string {
  const envKey = `MODEL_TIER_${tier.toUpperCase()}_ID`;
  return process.env[envKey] || defaultId;
}

function extractProvider(modelId: string): string {
  if (modelId.includes("/")) {
    return normalizeProviderKey(modelId.split("/")[0]);
  }
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  return "openai";
}

const FAST_MODEL_ID = getEnvModelId("fast", "minimax/minimax-m2.7");
const PRO_MODEL_ID = getEnvModelId("pro", OPENROUTER_DEFAULT_TEXT_MODEL);
const ULTRA_MODEL_ID = getEnvModelId("ultra", "anthropic/claude-opus-4.7");

export const MODEL_TIERS: Record<ModelTier, ModelTierConfig> = {
  fast: {
    id: "fast",
    name: "Fast",
    description: "Fastest for quick answers",
    modelId: FAST_MODEL_ID,
    provider: extractProvider(FAST_MODEL_ID),
    icon: "zap",
    pricing: {
      inputPer1k: 0.00024,
      outputPer1k: 0.0012,
      currency: "USD",
    },
    capabilities: ["text", "code", "function_calling"],
    contextWindow: 128000,
  },
  pro: {
    id: "pro",
    name: "Pro",
    description: "Recommended for everyday tasks",
    modelId: PRO_MODEL_ID,
    provider: extractProvider(PRO_MODEL_ID),
    icon: "sparkles",
    pricing: {
      inputPer1k: 0.000039,
      outputPer1k: 0.00018,
      currency: "USD",
    },
    capabilities: ["text", "code", "reasoning", "function_calling", "long_context"],
    contextWindow: 131072,
    recommended: true,
  },
  ultra: {
    id: "ultra",
    name: "Ultra",
    description: "Most capable for complex work",
    modelId: ULTRA_MODEL_ID,
    provider: extractProvider(ULTRA_MODEL_ID),
    icon: "crown",
    pricing: {
      inputPer1k: 0.018,
      outputPer1k: 0.09,
      currency: "USD",
    },
    capabilities: ["text", "code", "reasoning", "vision", "function_calling", "long_context"],
    contextWindow: 200000,
  },
} as const;

export const MODEL_TIER_LIST: ModelTierConfig[] = [
  MODEL_TIERS.fast,
  MODEL_TIERS.pro,
  MODEL_TIERS.ultra,
];

/**
 * Additional models available in "More models" submenu.
 * Maps to ALLOWED_CHAT_MODELS from config.ts
 */
export interface AdditionalModel {
  id: string;
  name: string;
  description: string;
  modelId: string;
  provider: string;
  recommended?: boolean;
  free?: boolean;
}

/**
 * Image generation models
 * Note: Gemini Pro is expensive ($120/M output tokens)
 */
export interface ImageModel {
  id: string;
  name: string;
  description: string;
  modelId: string;
  provider: string;
  tier: "fast" | "pro" | "ultra";
  /** Warning message to show users (e.g., for expensive models) */
  warning?: string;
}

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "gemini-flash-image",
    name: "Gemini Flash",
    description: "Fastest for quick images",
    modelId: "google/gemini-2.5-flash-image",
    provider: "google",
    tier: "fast",
  },
  {
    id: "gemini-pro-image",
    name: "Gemini Pro",
    description: "Best for everyday images",
    modelId: "google/gemini-3-pro-image-preview",
    provider: "google",
    tier: "pro",
  },
  {
    id: "gemini-flash-image-preview",
    name: "Gemini 3.1 Flash Image Preview",
    description: "Most capable for complex images",
    modelId: "google/gemini-3.1-flash-image-preview",
    provider: "google",
    tier: "ultra",
  },
];

/** Image tiers for tier-based selection (like text models) */
export const IMAGE_TIERS: {
  id: ModelTier;
  name: string;
  description: string;
  model: ImageModel;
}[] = [
  {
    id: "fast",
    name: "Fast",
    description: "Fastest for quick images",
    model: IMAGE_MODELS[0],
  },
  {
    id: "pro",
    name: "Pro",
    description: "Best for everyday images",
    model: IMAGE_MODELS[1],
  },
  {
    id: "ultra",
    name: "Ultra",
    description: "Most capable for complex images",
    model: IMAGE_MODELS[2],
  },
];

/** Additional image models shown in "More models" submenu */
export const ADDITIONAL_IMAGE_MODELS: ImageModel[] = [
  {
    id: "gpt-5.4-image-2",
    name: "GPT-5.4 Image 2",
    description: "OpenAI's latest image generation model",
    modelId: "openai/gpt-5.4-image-2",
    provider: "openai",
    tier: "pro",
  },
  {
    id: "gpt-5-image-mini",
    name: "GPT-5 Image Mini",
    description: "OpenAI's fast image model",
    modelId: "openai/gpt-5-image-mini",
    provider: "openai",
    tier: "fast",
  },
  {
    id: "gpt-5-image",
    name: "GPT-5 Image",
    description: "Premium OpenAI image generation",
    modelId: "openai/gpt-5-image",
    provider: "openai",
    tier: "pro",
  },
];

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0];

export const ADDITIONAL_MODELS: AdditionalModel[] = [
  {
    id: "gpt-oss-120b-nitro",
    name: "GPT OSS 120B Nitro",
    description: "Recommended OpenRouter high-throughput reasoning model",
    modelId: OPENROUTER_RECOMMENDED_TEXT_MODEL,
    provider: "openai",
    recommended: true,
  },
  {
    id: "gpt-oss-120b-free",
    name: "GPT OSS 120B Free",
    description: "Free OpenRouter reasoning model",
    modelId: OPENROUTER_DEFAULT_FREE_MODEL,
    provider: "openai",
    free: true,
  },
  // OpenAI
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description: "Latest-generation OpenAI flagship",
    modelId: "openai/gpt-5.5",
    provider: "openai",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Flagship OpenAI model",
    modelId: "openai/gpt-5.4",
    provider: "openai",
  },
  {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    description: "Highest-precision OpenAI model",
    modelId: "openai/gpt-5.4-pro",
    provider: "openai",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Fast & affordable latest GPT-5 tier",
    modelId: "openai/gpt-5.4-mini",
    provider: "openai",
  },
  // Anthropic
  {
    id: "claude-opus",
    name: "Claude Opus 4.7",
    description: "Most powerful",
    modelId: "anthropic/claude-opus-4.7",
    provider: "anthropic",
  },
  {
    id: "claude-sonnet",
    name: "Claude Sonnet 4.6",
    description: "Balanced and capable",
    modelId: "anthropic/claude-sonnet-4.6",
    provider: "anthropic",
  },
  {
    id: "claude-haiku",
    name: "Claude Haiku 4.5",
    description: "Fast Anthropic option",
    modelId: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
  },
  // Google
  {
    id: "gemini-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description: "Fastest option",
    modelId: "google/gemini-2.5-flash-lite",
    provider: "google",
  },
  {
    id: "gemini-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast & smart",
    modelId: "google/gemini-2.5-flash",
    provider: "google",
  },
  {
    id: "gemini-pro",
    name: "Gemini 3 Pro",
    description: "Advanced reasoning",
    modelId: "google/gemini-3-pro-preview",
    provider: "google",
  },
  // DeepSeek
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "DeepSeek's flagship",
    modelId: "deepseek/deepseek-v4-pro",
    provider: "deepseek",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "Fast & affordable DeepSeek V4",
    modelId: "deepseek/deepseek-v4-flash",
    provider: "deepseek",
  },
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    description: "Open & powerful",
    modelId: "deepseek/deepseek-v3.2",
    provider: "deepseek",
  },
  // X.AI
  {
    id: "grok-4",
    name: "Grok 4",
    description: "X.AI's most powerful",
    modelId: "x-ai/grok-4",
    provider: "xai",
  },
  // Mistral
  {
    id: "magistral-medium",
    name: "Magistral Medium",
    description: "Mistral's most capable",
    modelId: "mistralai/magistral-medium",
    provider: "mistral",
  },
  // Alibaba (Qwen)
  {
    id: "qwen3-max",
    name: "Qwen 3 Max",
    description: "Alibaba's most powerful",
    modelId: "alibaba/qwen3-max",
    provider: "alibaba",
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen 3.5 Plus",
    description: "Latest Qwen generation",
    modelId: "alibaba/qwen3.5-plus",
    provider: "alibaba",
  },
  // Minimax
  {
    id: "minimax-m2.7",
    name: "Minimax M2.7",
    description: "Fast & affordable default",
    modelId: "minimax/minimax-m2.7",
    provider: "minimax",
  },
  {
    id: "minimax-m2.5",
    name: "Minimax M2.5",
    description: "Previous-generation Minimax",
    modelId: "minimax/minimax-m2.5",
    provider: "minimax",
  },
  // Z.AI (Zhipu)
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    description: "Z.AI (Zhipu) latest flagship",
    modelId: "zai/glm-5.1",
    provider: "zai",
  },
  // Moonshot (Kimi)
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    description: "Moonshot's latest flagship",
    modelId: "moonshotai/kimi-k2.6",
    provider: "moonshotai",
  },
  // Meta (Llama)
  {
    id: "llama-4-maverick",
    name: "Llama 4 Maverick",
    description: "Meta's frontier model",
    modelId: "meta/llama-4-maverick",
    provider: "meta",
  },
  // ByteDance
  {
    id: "seed-1.8",
    name: "Seed 1.8",
    description: "ByteDance's frontier model",
    modelId: "bytedance/seed-1.8",
    provider: "bytedance",
  },
  // Perplexity
  {
    id: "sonar-pro",
    name: "Sonar Pro",
    description: "Perplexity's web-grounded model",
    modelId: "perplexity/sonar-pro",
    provider: "perplexity",
  },
  {
    id: "sonar-reasoning-pro",
    name: "Sonar Reasoning Pro",
    description: "Perplexity reasoning + web search",
    modelId: "perplexity/sonar-reasoning-pro",
    provider: "perplexity",
  },
  // Amazon
  {
    id: "nova-pro",
    name: "Nova Pro",
    description: "Amazon's flagship Nova model",
    modelId: "amazon/nova-pro",
    provider: "amazon",
  },
  {
    id: "nova-2-lite",
    name: "Nova 2 Lite",
    description: "Latest fast Amazon Nova",
    modelId: "amazon/nova-2-lite",
    provider: "amazon",
  },
  // Cohere
  {
    id: "command-a",
    name: "Command A",
    description: "Cohere's flagship enterprise model",
    modelId: "cohere/command-a",
    provider: "cohere",
  },
  // Inception
  {
    id: "mercury-2",
    name: "Mercury 2",
    description: "Inception's diffusion language model",
    modelId: "inception/mercury-2",
    provider: "inception",
  },
  // Meituan (LongCat)
  {
    id: "longcat-flash-thinking",
    name: "LongCat Flash Thinking",
    description: "Meituan's reasoning model",
    modelId: "meituan/longcat-flash-thinking-2601",
    provider: "meituan",
  },
];

/**
 * Agent editing tiers - uses more capable models for character and configuration tasks.
 * The fast tier uses a better model since gpt-oss can't handle complex editing instructions.
 */
export const AGENT_EDITING_TIERS: Record<ModelTier, ModelTierConfig> = {
  fast: {
    ...MODEL_TIERS.fast,
    modelId: "minimax/minimax-m2.7",
    provider: "minimax",
    description: "Fast responses for agent editing",
  },
  pro: {
    ...MODEL_TIERS.pro,
    recommended: true,
  },
  ultra: MODEL_TIERS.ultra,
};

export const AGENT_EDITING_TIER_LIST: ModelTierConfig[] = [
  AGENT_EDITING_TIERS.fast,
  AGENT_EDITING_TIERS.pro,
  AGENT_EDITING_TIERS.ultra,
];

export const DEFAULT_MODEL_TIER: ModelTier = "pro";

/**
 * Resolve a model tier or raw model ID to a full model configuration
 *
 * @param tierOrModelId - Either a tier name ("fast", "pro", "ultra") or a raw model ID
 * @returns The resolved model configuration, falling back to pro tier if invalid
 *
 * @example
 * // Using tier name
 * const config = resolveModel("fast");
 * logger.info(config.modelId); // "google/gemini-2.5-flash-lite"
 *
 * // Using raw model ID (returns matching tier or creates custom config)
 * const config = resolveModel("anthropic/claude-sonnet-4.6");
 */
export function resolveModel(tierOrModelId?: string | null): ModelTierConfig {
  if (!tierOrModelId) {
    return MODEL_TIERS[DEFAULT_MODEL_TIER];
  }

  if (isValidModelTier(tierOrModelId)) {
    return MODEL_TIERS[tierOrModelId];
  }

  const tierFromModel = getTierFromModelId(tierOrModelId);
  if (tierFromModel) {
    return MODEL_TIERS[tierFromModel];
  }

  return {
    ...MODEL_TIERS[DEFAULT_MODEL_TIER],
    modelId: tierOrModelId,
    provider: extractProvider(tierOrModelId),
    name: "Custom",
    description: tierOrModelId,
  };
}

/**
 * Get the model ID for a given tier.
 *
 * @param tier - Model tier.
 * @returns Model ID string.
 */
export function getModelIdFromTier(tier: ModelTier): string {
  return MODEL_TIERS[tier]?.modelId ?? MODEL_TIERS[DEFAULT_MODEL_TIER].modelId;
}

/**
 * Get the tier for a given model ID.
 *
 * @param modelId - Model ID string.
 * @returns Model tier or null if not found.
 */
export function getTierFromModelId(modelId: string): ModelTier | null {
  const candidates = expandOpenRouterModelIdCandidates(modelId);
  for (const [tier, config] of Object.entries(MODEL_TIERS)) {
    const tierCandidates = expandOpenRouterModelIdCandidates(config.modelId);
    if (candidates.some((id) => tierCandidates.includes(id))) {
      return tier as ModelTier;
    }
  }
  return null;
}

/**
 * Type guard to check if a string is a valid model tier.
 *
 * @param tier - String to check.
 * @returns True if the string is a valid model tier.
 */
export function isValidModelTier(tier: string): tier is ModelTier {
  return tier in MODEL_TIERS;
}

/**
 * Get pricing estimate for a request
 */
export function estimateTierCost(
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): number {
  const config = MODEL_TIERS[tier];
  const inputCost = (inputTokens / 1000) * config.pricing.inputPer1k;
  const outputCost = (outputTokens / 1000) * config.pricing.outputPer1k;
  return Math.ceil((inputCost + outputCost) * 100) / 100;
}

/**
 * Check if a tier has a specific capability
 */
export function tierHasCapability(tier: ModelTier, capability: ModelCapability): boolean {
  return MODEL_TIERS[tier].capabilities.includes(capability);
}

/**
 * Get all tiers that have a specific capability
 */
export function getTiersWithCapability(capability: ModelCapability): ModelTier[] {
  return MODEL_TIER_LIST.filter((config) => config.capabilities.includes(capability)).map(
    (config) => config.id,
  );
}

/**
 * Get display info for UI components
 */
export function getTierDisplayInfo(tier: ModelTier): {
  name: string;
  modelId: string;
  description: string;
  priceIndicator: "$" | "$$" | "$$$";
} {
  const config = MODEL_TIERS[tier];
  const priceIndicator = tier === "fast" ? "$" : tier === "pro" ? "$$" : "$$$";

  return {
    name: config.name,
    modelId: config.modelId,
    description: config.description,
    priceIndicator,
  };
}

export const STORAGE_KEY = "eliza-model-tier";
