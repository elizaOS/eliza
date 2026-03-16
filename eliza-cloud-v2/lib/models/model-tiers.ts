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
    return modelId.split("/")[0];
  }
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  return "openai";
}

const FAST_MODEL_ID = getEnvModelId("fast", "openai/gpt-oss-120b");
const PRO_MODEL_ID = getEnvModelId("pro", "anthropic/claude-opus-4.5");
const ULTRA_MODEL_ID = getEnvModelId("ultra", "anthropic/claude-sonnet-4.5");

export const MODEL_TIERS: Record<ModelTier, ModelTierConfig> = {
  fast: {
    id: "fast",
    name: "Fast",
    description: "Fastest for quick answers",
    modelId: FAST_MODEL_ID,
    provider: extractProvider(FAST_MODEL_ID),
    icon: "zap",
    pricing: {
      inputPer1k: 0.0001,
      outputPer1k: 0.0004,
      currency: "USD",
    },
    capabilities: ["text", "code", "function_calling"],
    contextWindow: 128000,
  },
  pro: {
    id: "pro",
    name: "Pro",
    description: "Best for everyday tasks",
    modelId: PRO_MODEL_ID,
    provider: extractProvider(PRO_MODEL_ID),
    icon: "sparkles",
    pricing: {
      inputPer1k: 0.001,
      outputPer1k: 0.005,
      currency: "USD",
    },
    capabilities: [
      "text",
      "code",
      "reasoning",
      "vision",
      "function_calling",
      "long_context",
    ],
    contextWindow: 200000,
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
      inputPer1k: 0.015,
      outputPer1k: 0.075,
      currency: "USD",
    },
    capabilities: [
      "text",
      "code",
      "reasoning",
      "vision",
      "function_calling",
      "long_context",
    ],
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
    modelId: "google/gemini-3-pro-image",
    provider: "google",
    tier: "pro",
  },
  {
    id: "gemini-flash-preview",
    name: "Gemini Flash Preview",
    description: "Most capable for complex images",
    modelId: "google/gemini-2.5-flash-image-preview",
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
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    description: "OpenAI's fast image model",
    modelId: "openai/gpt-5-nano",
    provider: "openai",
    tier: "fast",
  },
  {
    id: "flux-kontext-max",
    name: "Flux Kontext Max",
    description: "Premium quality generation",
    modelId: "bfl/flux-kontext-max",
    provider: "bfl",
    tier: "pro",
  },
];

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0];

export const ADDITIONAL_MODELS: AdditionalModel[] = [
  // Moonshot AI
  {
    id: "kimi-k2",
    name: "Kimi K2",
    description: "Fast & capable",
    modelId: "moonshotai/kimi-k2-0905",
    provider: "moonshot",
  },
  {
    id: "kimi-k2-turbo",
    name: "Kimi K2 Turbo",
    description: "Extra speed",
    modelId: "moonshotai/kimi-k2-turbo",
    provider: "moonshot",
  },
  // OpenAI
  {
    id: "gpt-5",
    name: "GPT-5",
    description: "Most capable OpenAI",
    modelId: "openai/gpt-5",
    provider: "openai",
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    description: "Fast & affordable",
    modelId: "openai/gpt-5-mini",
    provider: "openai",
  },
  // Anthropic
  {
    id: "claude-opus",
    name: "Claude Opus 4.1",
    description: "Most powerful",
    modelId: "anthropic/claude-opus-4.1",
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
    id: "deepseek-v3",
    name: "DeepSeek V3.2",
    description: "Open & powerful",
    modelId: "deepseek/deepseek-v3.2-exp",
    provider: "deepseek",
  },
  {
    id: "deepseek-r1",
    name: "DeepSeek R1",
    description: "Reasoning model",
    modelId: "deepseek/deepseek-r1",
    provider: "deepseek",
  },
];

/**
 * Build mode tiers - uses more capable models for character building tasks.
 * The fast tier uses a better model since gpt-oss can't handle complex build instructions.
 */
export const BUILD_MODE_TIERS: Record<ModelTier, ModelTierConfig> = {
  fast: {
    ...MODEL_TIERS.fast,
    modelId: "moonshotai/kimi-k2-0905",
    provider: "moonshotai",
    description: "Fast responses for build mode",
  },
  pro: {
    ...MODEL_TIERS.pro,
    recommended: true,
  },
  ultra: MODEL_TIERS.ultra,
};

export const BUILD_MODE_TIER_LIST: ModelTierConfig[] = [
  BUILD_MODE_TIERS.fast,
  BUILD_MODE_TIERS.pro,
  BUILD_MODE_TIERS.ultra,
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
 * const config = resolveModel("anthropic/claude-sonnet-4.5");
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
  for (const [tier, config] of Object.entries(MODEL_TIERS)) {
    if (config.modelId === modelId) {
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
export function tierHasCapability(
  tier: ModelTier,
  capability: ModelCapability,
): boolean {
  return MODEL_TIERS[tier].capabilities.includes(capability);
}

/**
 * Get all tiers that have a specific capability
 */
export function getTiersWithCapability(
  capability: ModelCapability,
): ModelTier[] {
  return MODEL_TIER_LIST.filter((config) =>
    config.capabilities.includes(capability),
  ).map((config) => config.id);
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
