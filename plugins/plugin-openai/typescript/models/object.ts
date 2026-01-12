import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateObject } from "ai";
import { createOpenAIClient } from "../providers";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { getJsonRepairFunction } from "../utils/json";

type ModelNameGetter = (runtime: IAgentRuntime) => string;

async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter
): Promise<Record<string, unknown>> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);

  if (!params.prompt || params.prompt.trim().length === 0) {
    throw new Error("Object generation requires a non-empty prompt");
  }

  if (params.schema) {
    logger.debug(
      "[OpenAI] Schema provided but using no-schema mode. " +
        "Structure is determined by prompt instructions."
    );
  }

  const model = openai.chat(modelName);
  const { object, usage } = await generateObject({
    model,
    output: "no-schema",
    prompt: params.prompt,
    experimental_repairText: getJsonRepairFunction(),
  });

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  if (typeof object !== "object" || object === null) {
    throw new Error(`Object generation returned ${typeof object}, expected object`);
  }

  return object as Record<string, unknown>;
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, getSmallModel);
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, getLargeModel);
}
