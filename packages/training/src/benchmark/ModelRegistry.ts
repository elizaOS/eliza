/**
 * Model Registry
 *
 * Centralized configuration for all models available for benchmarking.
 * Add new models here to make them available for comparison.
 */

export interface ModelConfig {
  /** Unique identifier for the model */
  id: string;

  /** Display name for reports */
  displayName: string;

  /** Provider (groq, openai, anthropic, etc.) */
  provider: "groq" | "openai" | "anthropic" | "together" | "local";

  /** Model identifier for the provider's API */
  modelId: string;

  /** Model tier (lite, standard, pro) */
  tier: "lite" | "standard" | "pro";

  /** Approximate parameters in billions */
  parametersBillions?: number;

  /** Whether this is a baseline model */
  isBaseline: boolean;

  /** Additional metadata */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Registry of all available models for benchmarking
 */
export const MODEL_REGISTRY: ModelConfig[] = [
  {
    id: "llama-8b",
    displayName: "LLaMA 3.1 8B",
    provider: "groq",
    modelId: "llama-3.1-8b-instant",
    tier: "lite",
    parametersBillions: 8,
    isBaseline: true,
  },
  {
    id: "llama-70b",
    displayName: "LLaMA 3.1 70B",
    provider: "groq",
    modelId: "llama-3.1-70b-versatile",
    tier: "standard",
    parametersBillions: 70,
    isBaseline: false,
  },
  {
    id: "qwen-32b",
    displayName: "Qwen 3 32B",
    provider: "groq",
    modelId: "qwen/qwen3-32b",
    tier: "standard",
    parametersBillions: 32,
    isBaseline: true,
  },
  {
    id: "mixtral-8x7b",
    displayName: "Mixtral 8x7B",
    provider: "groq",
    modelId: "mixtral-8x7b-32768",
    tier: "standard",
    parametersBillions: 46,
    isBaseline: false,
  },
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "openai",
    modelId: "gpt-4o",
    tier: "pro",
    isBaseline: false,
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    provider: "openai",
    modelId: "gpt-4o-mini",
    tier: "lite",
    isBaseline: false,
  },
  {
    id: "claude-sonnet",
    displayName: "Claude 3.5 Sonnet",
    provider: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    tier: "pro",
    isBaseline: false,
  },
  {
    id: "claude-haiku",
    displayName: "Claude 3.5 Haiku",
    provider: "anthropic",
    modelId: "claude-3-5-haiku-20241022",
    tier: "lite",
    isBaseline: false,
  },
];

/**
 * Get a model config by ID
 */
export function getModelById(id: string): ModelConfig | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/**
 * Get a model config by model ID (API identifier)
 */
export function getModelByModelId(modelId: string): ModelConfig | undefined {
  return MODEL_REGISTRY.find((m) => m.modelId === modelId);
}

/**
 * Get all baseline models
 */
export function getBaselineModels(): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => m.isBaseline);
}

/**
 * Get models by provider
 */
export function getModelsByProvider(
  provider: ModelConfig["provider"],
): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/**
 * Get models by tier
 */
export function getModelsByTier(tier: ModelConfig["tier"]): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => m.tier === tier);
}

/**
 * Validate that a model ID exists
 */
export function validateModelId(id: string): boolean {
  return MODEL_REGISTRY.some((m) => m.id === id || m.modelId === id);
}

/**
 * Get model display name (supports both id and modelId)
 */
export function getModelDisplayName(idOrModelId: string): string {
  const model = getModelById(idOrModelId) ?? getModelByModelId(idOrModelId);
  return model?.displayName ?? idOrModelId;
}
