import {
  type IAgentRuntime,
  type JsonValue,
  ModelType,
  type ObjectGenerationParams,
  type RecordLlmCallDetails,
  recordLlmCall,
} from "@elizaos/core";
import { generateObject, jsonSchema, type LanguageModel } from "ai";
import type { JSONSchema7 } from "json-schema";

import { createOpenRouterProvider } from "../providers";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { handleObjectGenerationError } from "../utils/helpers";

function applyUsageToDetails(details: RecordLlmCallDetails, usage: unknown): void {
  if (!usage || typeof usage !== "object") {
    return;
  }
  const record = usage as {
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  details.promptTokens = record.inputTokens ?? record.promptTokens ?? 0;
  details.completionTokens = record.outputTokens ?? record.completionTokens ?? 0;
}

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
    const model = openrouter.chat(modelName) as LanguageModel;
    const details: RecordLlmCallDetails = {
      model: modelName,
      systemPrompt: "",
      userPrompt: params.prompt,
      temperature,
      maxTokens: params.maxTokens ?? 8192,
      purpose: "external_llm",
      actionType: "ai.generateObject",
    };
    const { object, usage } = await recordLlmCall(runtime, details, async () => {
      const result = params.schema
        ? await generateObject({
            model,
            schema: jsonSchema(params.schema as JSONSchema7),
            output: "object",
            prompt: params.prompt,
            temperature,
          })
        : await generateObject({
            model,
            output: "no-schema",
            prompt: params.prompt,
            temperature,
          });
      details.response = JSON.stringify(result.object);
      applyUsageToDetails(details, result.usage);
      return result;
    });

    if (usage) {
      emitModelUsageEvent(runtime, modelType, params.prompt, usage, modelName);
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
