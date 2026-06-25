/**
 * RL Model Configuration
 *
 * Controls when and how RL-trained models are used for inference.
 * Designed to be:
 * - Enabled by default in local development
 * - Disabled by default in production
 * - Easy to toggle via environment variables
 * - Scalable to larger models when more memory is available
 * - Support quantized models for efficient multi-model loading
 */

import { logger } from "@feed/shared";

/**
 * Quantization modes for model loading
 */
export type QuantizationMode = "none" | "4bit" | "8bit";

/**
 * Model tiers for scaling based on available resources
 * Supports automatic selection based on GPU memory
 */
export type ModelTier = "small" | "medium" | "large" | "xlarge";

export const FEED_DEFAULT_BASE_MODEL = "google/gemma-4-E4B-it";

export interface ModelTierConfig {
  name: string;
  model: string;
  quantizedModel4bit?: string; // 4-bit quantized variant
  quantizedModel8bit?: string; // 8-bit quantized variant
  params: string;
  context: number;
  minVramGb: number;
  minVramGb4bit: number; // VRAM needed for 4-bit quantized
  minVramGb8bit: number; // VRAM needed for 8-bit quantized
}

/**
 * Available model tiers - scale up when resources allow
 * Gemma 4 E2B/E4B use 128K context; 12B/31B use 256K context.
 * The quantized model ids point at Google's hosted QAT GGUF repos.
 */
export const MODEL_TIERS: Record<ModelTier, ModelTierConfig> = {
  small: {
    name: "Small (Gemma 4 E2B)",
    model: "google/gemma-4-E2B-it",
    quantizedModel4bit: "google/gemma-4-E2B-it-qat-q4_0-gguf",
    quantizedModel8bit: "google/gemma-4-E2B-it-qat-q4_0-gguf",
    params: "E2B",
    context: 131072, // 128K context
    minVramGb: 6,
    minVramGb4bit: 3,
    minVramGb8bit: 5,
  },
  medium: {
    name: "Medium (Gemma 4 E4B)",
    model: FEED_DEFAULT_BASE_MODEL,
    quantizedModel4bit: "google/gemma-4-E4B-it-qat-q4_0-gguf",
    quantizedModel8bit: "google/gemma-4-E4B-it-qat-q4_0-gguf",
    params: "E4B",
    context: 131072, // 128K context
    minVramGb: 10,
    minVramGb4bit: 4,
    minVramGb8bit: 7,
  },
  large: {
    name: "Large (Gemma 4 12B)",
    model: "google/gemma-4-12B-it",
    quantizedModel4bit: "google/gemma-4-12B-it-qat-q4_0-gguf",
    quantizedModel8bit: "google/gemma-4-12B-it-qat-q4_0-gguf",
    params: "12B",
    context: 262144, // 256K context
    minVramGb: 32,
    minVramGb4bit: 10,
    minVramGb8bit: 18,
  },
  xlarge: {
    name: "XLarge (Gemma 4 31B)",
    model: "google/gemma-4-31B-it",
    quantizedModel4bit: "google/gemma-4-31B-it-qat-q4_0-gguf",
    quantizedModel8bit: "google/gemma-4-31B-it-qat-q4_0-gguf",
    params: "31B",
    context: 262144, // 256K context
    minVramGb: 80,
    minVramGb4bit: 24,
    minVramGb8bit: 44,
  },
};

/**
 * Multi-model configuration for running multiple archetypes simultaneously
 * Optimized for local multi-archetype runs where one GPU may host several
 * Gemma 4 QAT GGUF models at once.
 */
export interface MultiModelConfig {
  totalVramGb: number;
  maxConcurrentModels: number;
  quantization: QuantizationMode;
  modelTier: ModelTier;
}

/**
 * Calculate optimal multi-model configuration for available VRAM
 * Optimizes for running multiple archetype models simultaneously
 */
export function getMultiModelConfig(vramGb: number): MultiModelConfig {
  // Prefer the E2B tier for local multi-model coverage. Single-model and
  // hosted training defaults use FEED_DEFAULT_BASE_MODEL (Gemma 4 E4B).

  if (vramGb >= 16) {
    // 16GB: four E2B QAT GGUF models with room for orchestration overhead.
    return {
      totalVramGb: vramGb,
      maxConcurrentModels: 4,
      quantization: "4bit",
      modelTier: "small",
    };
  } else if (vramGb >= 12) {
    // 12GB: three E2B QAT GGUF models.
    return {
      totalVramGb: vramGb,
      maxConcurrentModels: 3,
      quantization: "4bit",
      modelTier: "small",
    };
  } else if (vramGb >= 8) {
    // 8GB: two E2B QAT GGUF models.
    return {
      totalVramGb: vramGb,
      maxConcurrentModels: 2,
      quantization: "4bit",
      modelTier: "small",
    };
  }
  // Less than 8GB: Single model only
  return {
    totalVramGb: vramGb,
    maxConcurrentModels: 1,
    quantization: "4bit",
    modelTier: "small",
  };
}

/**
 * Get the model name based on quantization mode
 */
export function getQuantizedModelName(
  tier: ModelTier,
  quantization: QuantizationMode,
): string {
  const tierConfig = MODEL_TIERS[tier];

  switch (quantization) {
    case "4bit":
      return tierConfig.quantizedModel4bit || tierConfig.model;
    case "8bit":
      return tierConfig.quantizedModel8bit || tierConfig.model;
    default:
      return tierConfig.model;
  }
}

/**
 * Get VRAM requirement based on tier and quantization
 */
export function getVramRequirement(
  tier: ModelTier,
  quantization: QuantizationMode,
): number {
  const tierConfig = MODEL_TIERS[tier];

  switch (quantization) {
    case "4bit":
      return tierConfig.minVramGb4bit;
    case "8bit":
      return tierConfig.minVramGb8bit;
    default:
      return tierConfig.minVramGb;
  }
}

export interface RLModelConfig {
  enabled: boolean;
  atroposApiUrl?: string;
  vllmPort?: number;
  /** If specified, use this version. Otherwise use latest. */
  modelVersion?: string;
  /** If RL model fails, fall back to base model */
  fallbackToBase: boolean;
  baseModel: string;
  modelTier: ModelTier;
  /** Auto-detected or set via environment variable */
  availableVramGb?: number;
  /** Quantization mode for efficient multi-model loading */
  quantization: QuantizationMode;
  /** Multi-model configuration for concurrent archetype models */
  multiModelConfig: MultiModelConfig;
}

/**
 * Archetype-specific model configuration
 * Allows different trained models per agent archetype
 */
export interface ArchetypeModelConfig {
  archetype: string;
  modelId: string;
  modelPath: string;
  baseModel: string;
  trainedAt?: Date;
  benchmarkScore?: number;
}

/**
 * Registry of trained models per archetype
 * Maps archetype -> best available model
 */
const archetypeModelRegistry: Map<string, ArchetypeModelConfig> = new Map();

/**
 * Register a trained model for an archetype
 */
export function registerArchetypeModel(config: ArchetypeModelConfig): void {
  const existing = archetypeModelRegistry.get(config.archetype);

  if (
    !existing ||
    (config.benchmarkScore &&
      (!existing.benchmarkScore ||
        config.benchmarkScore > existing.benchmarkScore))
  ) {
    archetypeModelRegistry.set(config.archetype, config);
    logger.info(
      `Registered model for archetype '${config.archetype}': ${config.modelId}`,
      { archetype: config.archetype, modelId: config.modelId },
      "RLModelConfig",
    );
  }
}

/**
 * Get the best model for a specific archetype
 * Falls back to base model if no archetype-specific model exists
 */
export function getModelForArchetype(
  archetype: string,
): ArchetypeModelConfig | null {
  const normalized = archetype.toLowerCase().trim().replace(/_/g, "-");
  return archetypeModelRegistry.get(normalized) || null;
}

/**
 * Get all registered archetype models
 */
export function getAllArchetypeModels(): ArchetypeModelConfig[] {
  return Array.from(archetypeModelRegistry.values());
}

/**
 * Check if an archetype has a trained model
 */
export function hasArchetypeModel(archetype: string): boolean {
  const normalized = archetype.toLowerCase().trim().replace(/_/g, "-");
  return archetypeModelRegistry.has(normalized);
}

/**
 * Clear all registered models
 */
export function clearArchetypeModels(): void {
  archetypeModelRegistry.clear();
}

/**
 * Get the appropriate model tier based on available VRAM
 */
export function getModelTierForVram(vramGb: number): ModelTier {
  if (vramGb >= MODEL_TIERS.xlarge.minVramGb) return "xlarge";
  if (vramGb >= MODEL_TIERS.large.minVramGb) return "large";
  if (vramGb >= MODEL_TIERS.medium.minVramGb) return "medium";
  return "small";
}

/**
 * Get model for a specific tier
 */
export function getModelForTier(tier: ModelTier): string {
  return MODEL_TIERS[tier].model;
}

/**
 * Get RL model configuration from environment
 */
export function getRLModelConfig(): RLModelConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const isLocal = process.env.NODE_ENV === "development" || !isProduction;

  // Explicit enable/disable flag
  const explicitFlag = process.env.USE_RL_MODEL;

  // Determine if enabled:
  // - If USE_RL_MODEL is explicitly set, use that value
  // - Otherwise, enabled in local, disabled in production
  const enabled = explicitFlag ? explicitFlag === "true" : isLocal;

  // Check for explicit tier or VRAM override
  const explicitTier = process.env.MODEL_TIER as ModelTier | undefined;
  const explicitVram = process.env.AVAILABLE_VRAM_GB
    ? parseInt(process.env.AVAILABLE_VRAM_GB, 10)
    : 16; // Default to 16GB (RTX 5090)

  // Determine quantization mode: explicit or auto-detect based on VRAM
  const explicitQuant = process.env.MODEL_QUANTIZATION as
    | QuantizationMode
    | undefined;
  const quantization: QuantizationMode = explicitQuant || "4bit"; // Default to 4-bit for efficiency

  // Get multi-model config based on available VRAM
  const multiModelConfig = getMultiModelConfig(explicitVram);

  // Determine tier: explicit tier > tier from multi-model config > default small
  let modelTier: ModelTier = "small";
  if (explicitTier && MODEL_TIERS[explicitTier]) {
    modelTier = explicitTier;
  } else {
    modelTier = multiModelConfig.modelTier;
  }

  // Use explicit BASE_MODEL if set, otherwise use quantized tier-based model
  const baseModel =
    process.env.BASE_MODEL || getQuantizedModelName(modelTier, quantization);

  return {
    enabled,
    atroposApiUrl: process.env.ATROPOS_API_URL || "http://localhost:8000",
    vllmPort: parseInt(process.env.VLLM_PORT || "9001", 10),
    modelVersion: process.env.RL_MODEL_VERSION, // Optional: pin to specific version
    fallbackToBase: process.env.RL_FALLBACK_TO_BASE !== "false", // Default: true
    baseModel,
    modelTier,
    availableVramGb: explicitVram,
    quantization,
    multiModelConfig,
  };
}

/**
 * Check if RL models are available and configured
 */
export function isRLModelAvailable(): boolean {
  const config = getRLModelConfig();

  if (!config.enabled) {
    return false;
  }

  // Need Atropos API URL to fetch RL models
  if (!config.atroposApiUrl) {
    logger.warn(
      "RL models enabled but Atropos API URL missing. Set ATROPOS_API_URL.",
      undefined,
      "RLModelConfig",
    );
    return false;
  }

  return true;
}

/**
 * Log configuration on startup
 */
export function logRLModelConfig(): void {
  const config = getRLModelConfig();
  const available = isRLModelAvailable();
  const tierConfig = MODEL_TIERS[config.modelTier];
  const vramPerModel = getVramRequirement(
    config.modelTier,
    config.quantization,
  );

  logger.info(
    "RL Model Configuration",
    {
      enabled: config.enabled,
      available,
      atroposConfigured: !!config.atroposApiUrl,
      vllmPort: config.vllmPort,
      pinnedVersion: config.modelVersion || "latest",
      fallbackEnabled: config.fallbackToBase,
      baseModel: config.baseModel,
      modelTier: config.modelTier,
      tierName: tierConfig.name,
      tierParams: tierConfig.params,
      contextWindow: tierConfig.context,
      availableVramGb: config.availableVramGb || "auto",
      quantization: config.quantization,
      vramPerModel: `${vramPerModel}GB`,
      maxConcurrentModels: config.multiModelConfig.maxConcurrentModels,
    },
    "RLModelConfig",
  );
}

/**
 * Get all available model tiers with their configurations
 */
export function getAvailableModelTiers(): ModelTierConfig[] {
  return Object.values(MODEL_TIERS);
}

/**
 * Check if a specific model tier is available based on VRAM
 */
export function isTierAvailable(tier: ModelTier, vramGb: number): boolean {
  return vramGb >= MODEL_TIERS[tier].minVramGb;
}
