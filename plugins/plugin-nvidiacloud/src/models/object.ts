import type { IAgentRuntime, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateObject, jsonSchema, type LanguageModel } from "ai";
import type { JSONSchema7 } from "json-schema";
import { createNvidiaOpenAI } from "../providers/nvidia";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import {
  getJsonRepairFunction,
  handleObjectGenerationError,
} from "../utils/helpers";

async function generateObjectWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.OBJECT_SMALL | typeof ModelType.OBJECT_LARGE,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  const client = createNvidiaOpenAI(runtime);
  const modelName =
    modelType === ModelType.OBJECT_SMALL
      ? getSmallModel(runtime)
      : getLargeModel(runtime);
  const modelLabel =
    modelType === ModelType.OBJECT_SMALL ? "OBJECT_SMALL" : "OBJECT_LARGE";

  logger.log(`[NVIDIA NIM] ${modelLabel}: ${modelName}`);
  const temperature = params.temperature ?? 0.7;

  try {
    const { object, usage } = await generateObject({
      model: client.chat(modelName) as LanguageModel,
      ...(params.schema && {
        schema: jsonSchema(params.schema as JSONSchema7),
      }),
      output: params.schema ? "object" : "no-schema",
      prompt: params.prompt,
      system: runtime.character.system ?? undefined,
      temperature,
      experimental_repairText: getJsonRepairFunction(),
    });

    if (usage) {
      emitModelUsageEvent(runtime, modelType, usage, modelName, modelLabel);
    }
    return object as Record<string, unknown>;
  } catch (error: unknown) {
    return handleObjectGenerationError(error);
  }
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithModel(runtime, ModelType.OBJECT_SMALL, params);
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithModel(runtime, ModelType.OBJECT_LARGE, params);
}
