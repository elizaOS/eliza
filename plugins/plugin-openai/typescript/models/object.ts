/**
 * Object generation model handlers
 *
 * Provides structured object generation using OpenAI's language models.
 */

import type {
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateObject } from "ai";
import { createOpenAIClient } from "../providers";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { getJsonRepairFunction } from "../utils/json";

// ============================================================================
// Types
// ============================================================================

/**
 * Function to get model name from runtime
 */
type ModelNameGetter = (runtime: IAgentRuntime) => string;

// ============================================================================
// Core Generation Function
// ============================================================================

/**
 * Generates a structured object using the specified model type.
 *
 * Uses the AI SDK's generateObject with no-schema mode, relying on
 * prompt-based instruction for structure. The experimental_repairText
 * function handles common JSON formatting issues.
 *
 * @param runtime - The agent runtime
 * @param params - Object generation parameters
 * @param modelType - The type of model to use
 * @param getModelFn - Function to get the model name
 * @returns The generated object
 */
async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter
): Promise<Record<string, unknown>> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);

  // Validate prompt
  if (!params.prompt || params.prompt.trim().length === 0) {
    throw new Error("Object generation requires a non-empty prompt");
  }

  const temperature = params.temperature ?? 0;

  // Log if schema is provided (currently ignored in no-schema mode)
  if (params.schema) {
    logger.debug(
      "[OpenAI] Schema provided but using no-schema mode. " +
        "Structure is determined by prompt instructions."
    );
  }

  const { object, usage } = await generateObject({
    model: openai.languageModel(modelName),
    output: "no-schema",
    prompt: params.prompt,
    temperature,
    experimental_repairText: getJsonRepairFunction(),
  });

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  // Validate that we got an object back
  if (typeof object !== "object" || object === null) {
    throw new Error(
      `Object generation returned ${typeof object}, expected object`
    );
  }

  return object as Record<string, unknown>;
}

// ============================================================================
// Public Handlers
// ============================================================================

/**
 * Handles OBJECT_SMALL model requests.
 *
 * Uses the configured small model for generating structured objects.
 * Best for simple, fast object generation tasks.
 *
 * @param runtime - The agent runtime
 * @param params - Object generation parameters
 * @returns The generated object
 */
export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_SMALL,
    getSmallModel
  );
}

/**
 * Handles OBJECT_LARGE model requests.
 *
 * Uses the configured large model for generating structured objects.
 * Best for complex object generation requiring deeper reasoning.
 *
 * @param runtime - The agent runtime
 * @param params - Object generation parameters
 * @returns The generated object
 */
export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_LARGE,
    getLargeModel
  );
}
