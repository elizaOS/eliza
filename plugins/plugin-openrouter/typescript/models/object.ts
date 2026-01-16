import {
  type IAgentRuntime,
  type JsonValue,
  ModelType,
  type ObjectGenerationParams,
} from "@elizaos/core";
import { generateObject, jsonSchema } from "ai";
import type { JSONSchema7 } from "json-schema";

import { createOpenRouterProvider } from "../providers";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { handleObjectGenerationError } from "../utils/helpers";

async function generateObjectWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.OBJECT_SMALL | typeof ModelType.OBJECT_LARGE,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  const openrouter = createOpenRouterProvider(runtime);
  const modelName =
    modelType === ModelType.OBJECT_SMALL ? getSmallModel(runtime) : getLargeModel(runtime);

  const temperature = params.temperature ?? 0.7;

  try {
    const generateParams = {
      model: openrouter.chat(modelName),
      ...(params.schema && {
        schema: jsonSchema(params.schema as JSONSchema7),
      }),
      output: params.schema ? "object" : "no-schema",
      prompt: params.prompt,
      temperature: temperature,
    };

    // @ts-expect-error - AI SDK type compatibility issue with OpenRouter provider
    const { object, usage } = await generateObject(generateParams);

    if (usage) {
      emitModelUsageEvent(runtime, modelType, params.prompt, usage);
    }
    return object as Record<string, JsonValue>;
  } catch (error: unknown) {
    return handleObjectGenerationError(error);
  }
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  return generateObjectWithModel(runtime, ModelType.OBJECT_SMALL, params);
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  return generateObjectWithModel(runtime, ModelType.OBJECT_LARGE, params);
}
