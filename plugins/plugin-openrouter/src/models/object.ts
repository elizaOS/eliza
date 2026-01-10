import {
  ModelType,
  logger,
  type IAgentRuntime,
  type ObjectGenerationParams,
} from "@elizaos/core";
import { generateObject, jsonSchema } from "ai";
import type { JSONSchema7 } from "json-schema";
import { createOpenRouterProvider } from "../providers";
import { getSmallModel, getLargeModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import {
  getJsonRepairFunction,
  handleObjectGenerationError,
} from "../utils/helpers";

/**
 * Common object generation logic for both small and large models
 */
async function generateObjectWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.OBJECT_SMALL | typeof ModelType.OBJECT_LARGE,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName =
    modelType === ModelType.OBJECT_SMALL
      ? getSmallModel(runtime)
      : getLargeModel(runtime);
  const modelLabel =
    modelType === ModelType.OBJECT_SMALL ? "OBJECT_SMALL" : "OBJECT_LARGE";

  logger.log(`[OpenRouter] Using ${modelLabel} model: ${modelName}`);
  const temperature = params.temperature ?? 0.7;

  try {
    const { object, usage } = await generateObject({
      model: openrouter.chat(modelName),
      ...(params.schema && { schema: jsonSchema(params.schema as JSONSchema7) }),
      output: params.schema ? "object" : "no-schema",
      prompt: params.prompt,
      temperature: temperature,
      experimental_repairText: getJsonRepairFunction(),
    });

    if (usage) {
      emitModelUsageEvent(runtime, modelType, params.prompt, usage);
    }
    return object as Record<string, unknown>;
  } catch (error: unknown) {
    return handleObjectGenerationError(error);
  }
}

/**
 * OBJECT_SMALL model handler
 */
export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithModel(runtime, ModelType.OBJECT_SMALL, params);
}

/**
 * OBJECT_LARGE model handler
 */
export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithModel(runtime, ModelType.OBJECT_LARGE, params);
}
