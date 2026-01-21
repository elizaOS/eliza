/**
 * Ollama Provider for Local Model Inference
 *
 * Provides local LLM inference using Ollama, supporting base models, fine-tuned models
 * with LoRA adapters, and archetype-specific model routing for RL training workflows.
 *
 * @remarks
 * Supports the closed-loop RL training process:
 * 1. Agents generate trajectory data using current models
 * 2. Training pipeline trains new models on trajectory data
 * 3. Trained models are benchmarked and exported to Ollama
 * 4. Agents use new models to generate improved trajectory data
 * 5. Process repeats with continuous model improvement
 *
 * @packageDocumentation
 */

import type { IAgentRuntime } from "@elizaos/core";
import { getTrajectoryContext } from "../plugins/plugin-trajectory-logger/src/action-interceptor";
import type { TrajectoryLoggerService } from "../plugins/plugin-trajectory-logger/src/TrajectoryLoggerService";
import { logger } from "../shared/logger";

/**
 * Ollama model metadata from API
 * @internal
 */
interface OllamaModelInfo {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

/**
 * Ollama API list models response
 * @internal
 */
interface OllamaListResponse {
  models: OllamaModelInfo[];
}

/**
 * Mapping of agent archetypes to their trained Ollama model names
 * Updated when new models are trained, benchmarked, and deployed
 */
const ARCHETYPE_MODELS: Record<string, string> = {
  trader: "polyagent-trader:latest",
  "social-butterfly": "polyagent-social:latest",
  scammer: "polyagent-scammer:latest",
  degen: "polyagent-degen:latest",
  "information-trader": "polyagent-info-trader:latest",
  researcher: "polyagent-researcher:latest",
  "goody-twoshoes": "polyagent-goody:latest",
  "ass-kisser": "polyagent-asskisser:latest",
  "perps-trader": "polyagent-perps:latest",
  "super-predictor": "polyagent-predictor:latest",
  infosec: "polyagent-infosec:latest",
  liar: "polyagent-liar:latest",
};

// Default fallback model
const DEFAULT_MODEL = "qwen2.5:7b-instruct";

// Ollama configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export interface OllamaCallParams {
  prompt: string;
  system?: string;
  archetype?: string;
  modelOverride?: string;
  temperature?: number;
  maxTokens?: number;
  trajectoryLogger?: TrajectoryLoggerService;
  trajectoryId?: string;
  purpose?: "action" | "reasoning" | "evaluation" | "response" | "other";
  actionType?: string;
  runtime?: IAgentRuntime;
}

/**
 * Check if Ollama is available
 */
export async function isOllamaAvailable(): Promise<boolean> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    method: "GET",
    signal: AbortSignal.timeout(2000),
  });
  return response.ok;
}

/**
 * List available Ollama models
 */
export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    method: "GET",
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = (await response.json()) as OllamaListResponse;
  return data.models || [];
}

/**
 * Check if a specific model is available in Ollama
 */
export async function isModelAvailable(modelName: string): Promise<boolean> {
  const models = await listOllamaModels();
  return models.some(
    (m) =>
      m.name === modelName || m.name.startsWith(modelName.split(":")[0] ?? ""),
  );
}

/**
 * Get the best available model for an archetype
 */
export async function getModelForArchetype(archetype: string): Promise<string> {
  // First, try the archetype-specific trained model
  const archetypeModel = ARCHETYPE_MODELS[archetype];
  if (archetypeModel && (await isModelAvailable(archetypeModel))) {
    return archetypeModel;
  }

  // Fall back to default model
  if (await isModelAvailable(DEFAULT_MODEL)) {
    return DEFAULT_MODEL;
  }

  // Last resort: any available model
  const models = await listOllamaModels();
  if (models.length > 0 && models[0]) {
    return models[0].name;
  }

  throw new Error("No Ollama models available");
}

/**
 * Call Ollama for local LLM inference
 *
 * Supports archetype-specific model routing and automatic trajectory logging
 */
export async function callOllama(params: OllamaCallParams): Promise<string> {
  // Auto-extract trajectory context from runtime if not explicitly provided
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

  // Determine which model to use
  let model: string;
  if (params.modelOverride) {
    model = params.modelOverride;
  } else if (params.archetype) {
    model = await getModelForArchetype(params.archetype);
  } else {
    model = DEFAULT_MODEL;
  }

  const startTime = Date.now();

  // Build messages for chat format
  const messages: Array<{ role: string; content: string }> = [];

  if (params.system) {
    messages.push({ role: "system", content: params.system });
  }

  messages.push({ role: "user", content: params.prompt });

  // Call Ollama chat API
  const timeoutMs = params.maxTokens && params.maxTokens < 500 ? 30000 : 120000;

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: params.temperature ?? 0.7,
        num_predict: params.maxTokens ?? 8192,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as {
    message?: { content: string };
    response?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const responseText = data.message?.content || data.response || "";
  const latencyMs = Date.now() - startTime;

  // Log to trajectory if available (CRITICAL for RL training data collection)
  if (trajectoryLogger && trajectoryId) {
    const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
    if (stepId) {
      trajectoryLogger.logLLMCall(stepId, {
        model,
        systemPrompt: params.system || "",
        userPrompt: params.prompt,
        response: responseText,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        purpose: params.purpose || "action",
        actionType: params.actionType,
        latencyMs,
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
      });
    }
  }

  logger.debug(
    "Ollama call complete",
    {
      model,
      archetype: params.archetype,
      latencyMs,
      responseLength: responseText.length,
    },
    "OllamaProvider",
  );

  return responseText;
}

/**
 * Update the model mapping for an archetype
 *
 * Called when a new model is trained, benchmarked, and ready for deployment
 */
export function updateArchetypeModel(
  archetype: string,
  modelName: string,
): void {
  ARCHETYPE_MODELS[archetype] = modelName;
  logger.info(
    "Updated archetype model",
    { archetype, modelName },
    "OllamaProvider",
  );
}

/**
 * Get current archetype model mappings
 */
export function getArchetypeModels(): Record<string, string> {
  return { ...ARCHETYPE_MODELS };
}

/**
 * Import a trained model into Ollama
 *
 * Converts a trained model (safetensors/pytorch) to Ollama format
 * and imports it for local inference.
 */
export async function importModelToOllama(params: {
  modelPath: string;
  modelName: string;
  baseModel?: string;
}): Promise<boolean> {
  // Create Modelfile for Ollama
  const modelfile = `FROM ${params.baseModel || "qwen2.5:7b-instruct"}
ADAPTER ${params.modelPath}
PARAMETER temperature 0.7
PARAMETER num_predict 8192
`;

  // Create the model in Ollama
  const response = await fetch(`${OLLAMA_BASE_URL}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: params.modelName,
      modelfile,
      stream: false,
    }),
    signal: AbortSignal.timeout(600000), // 10 minute timeout for model creation
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create Ollama model: ${errorText}`);
  }

  logger.info(
    "Successfully imported model to Ollama",
    { modelName: params.modelName },
    "OllamaProvider",
  );

  return true;
}
