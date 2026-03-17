/**
 * Multi-Model Orchestrator
 *
 * Manages loading and inference for multiple archetype-specific models
 * within VRAM constraints. Optimized for 16GB GPUs (RTX 5090).
 *
 * Strategy:
 * - Use 4-bit quantization to fit 4+ models in 16GB VRAM
 * - LRU cache for model loading/unloading
 * - Batch inference per archetype for efficiency
 * - Real vLLM/OpenAI-compatible API integration
 */

import { logger } from "../utils/logger";
import {
  getModelForArchetype as getArchetypeModel,
  getMultiModelConfig,
  getQuantizedModelName,
  getVramRequirement,
  type ModelTier,
  type MultiModelConfig,
  type QuantizationMode,
} from "./RLModelConfig";

/**
 * Loaded model state
 */
interface LoadedModel {
  archetype: string;
  modelId: string;
  tier: ModelTier;
  quantization: QuantizationMode;
  vramUsageGb: number;
  lastUsed: number;
  inferenceCount: number;
}

/**
 * Model inference request
 */
export interface ModelInferenceRequest {
  archetype: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Model inference result
 */
export interface ModelInferenceResult {
  archetype: string;
  response: string;
  modelId: string;
  latencyMs: number;
  tokensGenerated: number;
  error?: string;
}

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  availableVramGb: number;
  defaultTier: ModelTier;
  defaultQuantization: QuantizationMode;
  vllmBaseUrl?: string;
  /** Fallback to Groq/OpenAI when vLLM unavailable */
  fallbackApiKey?: string;
  fallbackApiUrl?: string;
  /** Timeout for inference in ms */
  inferenceTimeoutMs?: number;
}

/**
 * vLLM/OpenAI compatible response format
 */
interface CompletionResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Multi-Model Orchestrator
 *
 * Manages multiple quantized models for archetype-specific inference.
 * Uses LRU eviction when VRAM is constrained.
 */
export class MultiModelOrchestrator {
  private config: OrchestratorConfig;
  private multiModelConfig: MultiModelConfig;
  private loadedModels: Map<string, LoadedModel> = new Map();
  private currentVramUsageGb = 0;
  private vllmAvailable: boolean | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = {
      vllmBaseUrl: process.env.VLLM_BASE_URL || "http://localhost:9001",
      fallbackApiUrl:
        process.env.GROQ_API_URL || "https://api.groq.com/openai/v1",
      fallbackApiKey: process.env.GROQ_API_KEY,
      inferenceTimeoutMs: 30000,
      ...config,
    };
    this.multiModelConfig = getMultiModelConfig(config.availableVramGb);

    logger.info(
      "MultiModelOrchestrator initialized",
      {
        availableVram: `${config.availableVramGb}GB`,
        maxConcurrentModels: this.multiModelConfig.maxConcurrentModels,
        quantization: this.multiModelConfig.quantization,
        tier: this.multiModelConfig.modelTier,
        vllmUrl: this.config.vllmBaseUrl,
        hasFallback: !!this.config.fallbackApiKey,
      },
      "MultiModelOrchestrator",
    );
  }

  /**
   * Check if vLLM server is available
   */
  async checkVllmAvailability(): Promise<boolean> {
    if (this.vllmAvailable !== null) {
      return this.vllmAvailable;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.config.vllmBaseUrl}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.vllmAvailable = response.ok;

      if (this.vllmAvailable) {
        logger.info(
          "vLLM server is available",
          { url: this.config.vllmBaseUrl },
          "MultiModelOrchestrator",
        );
      }

      return this.vllmAvailable;
    } catch {
      clearTimeout(timeout);
      this.vllmAvailable = false;
      logger.warn(
        "vLLM server not available, will use fallback",
        { url: this.config.vllmBaseUrl },
        "MultiModelOrchestrator",
      );
      return false;
    }
  }

  /**
   * Get model info for an archetype
   */
  getModelForArchetype(archetype: string): {
    modelId: string;
    tier: ModelTier;
    quantization: QuantizationMode;
    vramGb: number;
  } {
    // Check if there's a trained archetype-specific model
    const archetypeModel = getArchetypeModel(archetype);
    if (archetypeModel) {
      return {
        modelId: archetypeModel.modelPath || archetypeModel.modelId,
        tier: this.config.defaultTier,
        quantization: this.config.defaultQuantization,
        vramGb: getVramRequirement(
          this.config.defaultTier,
          this.config.defaultQuantization,
        ),
      };
    }

    // Use default tier and quantization
    const tier = this.config.defaultTier;
    const quantization = this.config.defaultQuantization;
    const modelId = getQuantizedModelName(tier, quantization);
    const vramGb = getVramRequirement(tier, quantization);

    return { modelId, tier, quantization, vramGb };
  }

  /**
   * Check if we can load a model given current VRAM usage
   */
  canLoadModel(vramRequired: number): boolean {
    const availableVram = this.config.availableVramGb - this.currentVramUsageGb;
    return availableVram >= vramRequired;
  }

  /**
   * Evict least recently used model to free VRAM
   */
  private evictLRUModel(): void {
    if (this.loadedModels.size === 0) return;

    let lruArchetype: string | null = null;
    let lruTime = Infinity;

    for (const [archetype, model] of this.loadedModels) {
      if (model.lastUsed < lruTime) {
        lruTime = model.lastUsed;
        lruArchetype = archetype;
      }
    }

    if (lruArchetype) {
      const model = this.loadedModels.get(lruArchetype);
      if (model) {
        this.currentVramUsageGb -= model.vramUsageGb;
        this.loadedModels.delete(lruArchetype);

        logger.info(
          `Evicted model for archetype: ${lruArchetype}`,
          {
            freedVram: `${model.vramUsageGb}GB`,
            currentUsage: `${this.currentVramUsageGb}GB`,
          },
          "MultiModelOrchestrator",
        );
      }
    }
  }

  /**
   * Load a model for an archetype (tracks VRAM usage)
   */
  async loadModelForArchetype(archetype: string): Promise<LoadedModel> {
    const existing = this.loadedModels.get(archetype);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    const modelInfo = this.getModelForArchetype(archetype);

    // Evict models if necessary to make room
    while (!this.canLoadModel(modelInfo.vramGb) && this.loadedModels.size > 0) {
      this.evictLRUModel();
    }

    if (!this.canLoadModel(modelInfo.vramGb)) {
      throw new Error(
        `Cannot load model for ${archetype}: insufficient VRAM. ` +
          `Required: ${modelInfo.vramGb}GB, Available: ${this.config.availableVramGb - this.currentVramUsageGb}GB`,
      );
    }

    const loadedModel: LoadedModel = {
      archetype,
      modelId: modelInfo.modelId,
      tier: modelInfo.tier,
      quantization: modelInfo.quantization,
      vramUsageGb: modelInfo.vramGb,
      lastUsed: Date.now(),
      inferenceCount: 0,
    };

    this.loadedModels.set(archetype, loadedModel);
    this.currentVramUsageGb += modelInfo.vramGb;

    logger.info(
      `Loaded model for archetype: ${archetype}`,
      {
        modelId: modelInfo.modelId,
        vramUsed: `${modelInfo.vramGb}GB`,
        totalVramUsed: `${this.currentVramUsageGb}GB`,
        modelsLoaded: this.loadedModels.size,
      },
      "MultiModelOrchestrator",
    );

    return loadedModel;
  }

  /**
   * Call vLLM server for inference
   */
  private async callVllm(
    modelId: string,
    prompt: string,
    systemPrompt: string,
    maxTokens: number,
    temperature: number,
  ): Promise<CompletionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.inferenceTimeoutMs,
    );

    const response = await fetch(
      `${this.config.vllmBaseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`vLLM request failed: ${response.status} - ${error}`);
    }

    return response.json() as Promise<CompletionResponse>;
  }

  /**
   * Call fallback API (Groq/OpenAI) for inference
   */
  private async callFallbackApi(
    prompt: string,
    systemPrompt: string,
    maxTokens: number,
    temperature: number,
  ): Promise<CompletionResponse> {
    if (!this.config.fallbackApiKey) {
      throw new Error(
        "No fallback API key configured. Set GROQ_API_KEY environment variable.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.inferenceTimeoutMs,
    );

    // Use a fast model for fallback
    const fallbackModel = "llama-3.1-8b-instant";

    const response = await fetch(
      `${this.config.fallbackApiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.fallbackApiKey}`,
        },
        body: JSON.stringify({
          model: fallbackModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Fallback API request failed: ${response.status} - ${error}`,
      );
    }

    return response.json() as Promise<CompletionResponse>;
  }

  /**
   * Run inference for an archetype
   */
  async inference(
    request: ModelInferenceRequest,
  ): Promise<ModelInferenceResult> {
    const startTime = Date.now();

    // Ensure model is loaded (for VRAM tracking)
    const model = await this.loadModelForArchetype(request.archetype);
    model.inferenceCount++;

    const systemPrompt =
      request.systemPrompt ||
      `You are an AI agent with the ${request.archetype} archetype. Respond appropriately to the given situation.`;
    const maxTokens = request.maxTokens || 512;
    const temperature = request.temperature ?? 0.7;

    try {
      // Try vLLM first
      const vllmAvailable = await this.checkVllmAvailability();

      let completion: CompletionResponse;

      if (vllmAvailable) {
        completion = await this.callVllm(
          model.modelId,
          request.prompt,
          systemPrompt,
          maxTokens,
          temperature,
        );
      } else {
        // Fall back to Groq/OpenAI
        completion = await this.callFallbackApi(
          request.prompt,
          systemPrompt,
          maxTokens,
          temperature,
        );
      }

      const latencyMs = Date.now() - startTime;
      const response = completion.choices[0]?.message.content || "";
      const tokensGenerated = completion.usage?.completion_tokens || 0;

      logger.debug(
        `Inference completed for ${request.archetype}`,
        {
          modelId: model.modelId,
          latencyMs,
          tokensGenerated,
          usedVllm: vllmAvailable,
        },
        "MultiModelOrchestrator",
      );

      return {
        archetype: request.archetype,
        response,
        modelId: model.modelId,
        latencyMs,
        tokensGenerated,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error(
        `Inference failed for ${request.archetype}`,
        { error: errorMessage, latencyMs },
        "MultiModelOrchestrator",
      );

      return {
        archetype: request.archetype,
        response: "",
        modelId: model.modelId,
        latencyMs,
        tokensGenerated: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Batch inference for multiple archetypes
   */
  async batchInference(
    requests: ModelInferenceRequest[],
  ): Promise<ModelInferenceResult[]> {
    // Group requests by archetype for efficient batching
    const byArchetype = new Map<string, ModelInferenceRequest[]>();
    for (const req of requests) {
      const existing = byArchetype.get(req.archetype) || [];
      existing.push(req);
      byArchetype.set(req.archetype, existing);
    }

    const results: ModelInferenceResult[] = [];

    // Process each archetype's requests
    for (const [archetype, archetypeRequests] of byArchetype) {
      // Load model once per archetype
      await this.loadModelForArchetype(archetype);

      // Process all requests for this archetype in parallel (up to 5 concurrent)
      const batchSize = 5;
      for (let i = 0; i < archetypeRequests.length; i += batchSize) {
        const batch = archetypeRequests.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((req) => this.inference(req)),
        );
        results.push(...batchResults);
      }
    }

    return results;
  }

  /**
   * Get current orchestrator status
   */
  getStatus(): {
    loadedModels: Array<{
      archetype: string;
      modelId: string;
      vramGb: number;
      inferenceCount: number;
    }>;
    totalVramUsed: number;
    availableVram: number;
    maxConcurrentModels: number;
    vllmAvailable: boolean | null;
  } {
    const loadedModels = Array.from(this.loadedModels.values()).map((m) => ({
      archetype: m.archetype,
      modelId: m.modelId,
      vramGb: m.vramUsageGb,
      inferenceCount: m.inferenceCount,
    }));

    return {
      loadedModels,
      totalVramUsed: this.currentVramUsageGb,
      availableVram: this.config.availableVramGb - this.currentVramUsageGb,
      maxConcurrentModels: this.multiModelConfig.maxConcurrentModels,
      vllmAvailable: this.vllmAvailable,
    };
  }

  /**
   * Unload all models
   */
  unloadAll(): void {
    this.loadedModels.clear();
    this.currentVramUsageGb = 0;
    logger.info("Unloaded all models", {}, "MultiModelOrchestrator");
  }

  /**
   * Reset vLLM availability check (force re-check on next inference)
   */
  resetAvailabilityCheck(): void {
    this.vllmAvailable = null;
  }
}

/**
 * Create a multi-model orchestrator with sensible defaults for RTX 5090 (16GB)
 */
export function createMultiModelOrchestrator(
  vramGb = 16,
): MultiModelOrchestrator {
  return new MultiModelOrchestrator({
    availableVramGb: vramGb,
    defaultTier: "small",
    defaultQuantization: "4bit",
  });
}
