/**
 * Model Registry
 *
 * Centralized configuration for all models available for benchmarking.
 * Add new models here to make them available for comparison.
 *
 * Supports multiple providers:
 * - groq: Groq Cloud API
 * - openai: OpenAI API
 * - anthropic: Anthropic API
 * - together: Together AI API
 * - local: Local vLLM server (for trained models)
 */

export interface ModelConfig {
  /** Unique identifier for the model */
  id: string;

  /** Display name for reports */
  displayName: string;

  /** Provider (groq, openai, anthropic, etc.) */
  provider: 'groq' | 'openai' | 'anthropic' | 'together' | 'local';

  /** Model identifier for the provider's API */
  modelId: string;

  /** Model tier (lite, standard, pro) */
  tier: 'lite' | 'standard' | 'pro';

  /** Approximate parameters in billions */
  parametersBillions?: number;

  /** Whether this is a baseline model */
  isBaseline: boolean;

  /** For local models: path to adapter/checkpoint */
  adapterPath?: string;

  /** For local models: vLLM server URL */
  vllmUrl?: string;

  /** Additional metadata */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Registry of all available models for benchmarking
 */
export const MODEL_REGISTRY: ModelConfig[] = [
  {
    id: 'llama-8b',
    displayName: 'LLaMA 3.1 8B',
    provider: 'groq',
    modelId: 'llama-3.1-8b-instant',
    tier: 'lite',
    parametersBillions: 8,
    isBaseline: true,
  },
  {
    id: 'llama-70b',
    displayName: 'LLaMA 3.1 70B',
    provider: 'groq',
    modelId: 'llama-3.1-70b-versatile',
    tier: 'standard',
    parametersBillions: 70,
    isBaseline: false,
  },
  {
    id: 'gpt-oss-120b',
    displayName: 'GPT OSS 120B',
    provider: 'groq',
    modelId: 'openai/gpt-oss-120b',
    tier: 'standard',
    parametersBillions: 120,
    isBaseline: true,
  },
  {
    id: 'mixtral-8x7b',
    displayName: 'Mixtral 8x7B',
    provider: 'groq',
    modelId: 'mixtral-8x7b-32768',
    tier: 'standard',
    parametersBillions: 46,
    isBaseline: false,
  },
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    modelId: 'gpt-4o',
    tier: 'pro',
    isBaseline: false,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    tier: 'lite',
    isBaseline: false,
  },
  {
    id: 'claude-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    modelId: 'claude-3-5-sonnet-20241022',
    tier: 'pro',
    isBaseline: false,
  },
  {
    id: 'claude-haiku',
    displayName: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    modelId: 'claude-3-5-haiku-20241022',
    tier: 'lite',
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
  provider: ModelConfig['provider']
): ModelConfig[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/**
 * Get models by tier
 */
export function getModelsByTier(tier: ModelConfig['tier']): ModelConfig[] {
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

/**
 * Create a local vLLM model configuration
 *
 * Used for benchmarking trained models served by a local vLLM instance.
 *
 * @param options - Local model configuration options
 * @returns ModelConfig for the local model
 *
 * @example
 * ```typescript
 * const localModel = createLocalModel({
 *   id: 'trained-v1',
 *   displayName: 'Trained Model v1.0',
 *   baseModel: 'Qwen/Qwen3-4B',
 *   adapterPath: './trained_models/final_model',
 *   vllmUrl: 'http://localhost:9001',
 * });
 * ```
 */
export function createLocalModel(options: {
  id: string;
  displayName: string;
  baseModel: string;
  adapterPath?: string;
  vllmUrl?: string;
  parametersBillions?: number;
}): ModelConfig {
  return {
    id: options.id,
    displayName: options.displayName,
    provider: 'local',
    modelId: options.baseModel,
    tier: 'standard',
    parametersBillions: options.parametersBillions,
    isBaseline: false,
    adapterPath: options.adapterPath,
    vllmUrl: options.vllmUrl || 'http://localhost:9001',
    metadata: {
      baseModel: options.baseModel,
      isTrainedModel: true,
    },
  };
}

/**
 * Create local model config from environment variables
 *
 * Reads from:
 * - MODEL_PATH / ADAPTER_PATH: Path to trained adapter
 * - VLLM_URL: vLLM server URL
 * - BASE_MODEL: Base model name
 * - MODEL_DISPLAY_NAME: Display name for reports
 */
export function createLocalModelFromEnv(): ModelConfig | null {
  const modelPath = process.env.MODEL_PATH || process.env.ADAPTER_PATH;
  const vllmUrl = process.env.VLLM_URL || 'http://localhost:9001';
  const baseModel = process.env.BASE_MODEL || 'Qwen/Qwen3-4B';
  const displayName =
    process.env.MODEL_DISPLAY_NAME ||
    (modelPath ? `Trained: ${modelPath.split('/').pop()}` : null);

  if (!modelPath && !displayName) {
    return null;
  }

  return createLocalModel({
    id: 'local-trained',
    displayName: displayName || 'Local Trained Model',
    baseModel,
    adapterPath: modelPath,
    vllmUrl,
  });
}
