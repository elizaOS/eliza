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

/**
 * Quantization modes for model loading
 */
export type QuantizationMode = "none" | "4bit" | "8bit";

/**
 * Model tiers for scaling based on available resources
 * Supports automatic selection based on GPU memory
 */
export type ModelTier = "small" | "medium" | "large" | "xlarge";

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
 * All models have 128K context (critical requirement)
 * Quantized models reduce VRAM by ~4x (4-bit) or ~2x (8-bit)
 */
export const MODEL_TIERS: Record<ModelTier, ModelTierConfig> = {
  small: {
    name: "Small (4B)",
    model: "unsloth/Qwen3-4B-128K",
    quantizedModel4bit: "unsloth/Qwen3-4B-128K-bnb-4bit",
    quantizedModel8bit: "unsloth/Qwen3-4B-128K-GGUF",
    params: "4B",
    context: 131072, // 128K context
    minVramGb: 8,
    minVramGb4bit: 3,
    minVramGb8bit: 5,
  },
  medium: {
    name: "Medium (8B)",
    model: "unsloth/Qwen3-8B-128K",
    quantizedModel4bit: "unsloth/Qwen3-8B-128K-bnb-4bit",
    quantizedModel8bit: "unsloth/Qwen3-8B-128K-GGUF",
    params: "8B",
    context: 131072, // 128K context
    minVramGb: 16,
    minVramGb4bit: 5,
    minVramGb8bit: 9,
  },
  large: {
    name: "Large (14B)",
    model: "unsloth/Qwen3-14B-128K",
    quantizedModel4bit: "unsloth/Qwen3-14B-128K-bnb-4bit",
    quantizedModel8bit: "unsloth/Qwen3-14B-128K-GGUF",
    params: "14B",
    context: 131072, // 128K context
    minVramGb: 24,
    minVramGb4bit: 8,
    minVramGb8bit: 14,
  },
  xlarge: {
    name: "XLarge (32B)",
    model: "unsloth/Qwen3-32B-128K",
    quantizedModel4bit: "unsloth/Qwen3-32B-128K-bnb-4bit",
    quantizedModel8bit: "unsloth/Qwen3-32B-128K-GGUF",
    params: "32B",
    context: 131072, // 128K context
    minVramGb: 48,
    minVramGb4bit: 16,
    minVramGb8bit: 28,
  },
};

/**
 * Multi-model configuration for running multiple archetypes simultaneously
 * Optimized for 16GB VRAM (RTX 5090)
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
  // For 16GB VRAM, we want to run 4+ models using 4-bit quantization
  // Each 4B model at 4-bit uses ~3GB VRAM
  // Each 8B model at 4-bit uses ~5GB VRAM

  if (vramGb >= 16) {
    // 16GB: Can run 4x 4B models (4-bit) or 3x 8B models (4-bit)
    // Prefer 4B for more archetype coverage
    return {
      totalVramGb: vramGb,
      maxConcurrentModels: 4,
      quantization: "4bit",
      modelTier: "small",
    };
  } else if (vramGb >= 12) {
    // 12GB: Can run 3x 4B models (4-bit)
    return {
      totalVramGb: vramGb,
      maxConcurrentModels: 3,
      quantization: "4bit",
      modelTier: "small",
    };
  } else if (vramGb >= 8) {
    // 8GB: Can run 2x 4B models (4-bit)
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
    console.log(
      `📦 Registered model for archetype '${config.archetype}': ${config.modelId}`,
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
    console.warn(
      "RL models enabled but Atropos API URL missing. Set ATROPOS_API_URL.",
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

  console.log("🤖 RL Model Configuration:", {
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
  });
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
