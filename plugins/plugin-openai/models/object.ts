import type {
  IAgentRuntime,
  JsonValue,
  ModelTypeName,
  ObjectGenerationParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, ModelType, recordLlmCall } from "@elizaos/core";
import {
  generateObject,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createOpenAIClient } from "../providers";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { getJsonRepairFunction } from "../utils/json";

type ModelNameGetter = (runtime: IAgentRuntime) => string;
type ChatModelFactory = { chat: (modelName: string) => LanguageModel };

interface ObjectGenerationParamsWithNativeOptions extends ObjectGenerationParams {
  messages?: ModelMessage[];
  responseSchema?: unknown;
}

function resolveResponseSchema(params: ObjectGenerationParamsWithNativeOptions): unknown {
  const responseSchema = params.responseSchema ?? params.schema;
  if (responseSchema && typeof responseSchema === "object" && "schema" in responseSchema) {
    return (responseSchema as { schema: unknown }).schema;
  }
  return responseSchema;
}

async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter
): Promise<Record<string, JsonValue>> {
  const paramsWithNativeOptions = params as ObjectGenerationParamsWithNativeOptions;
  const openai = createOpenAIClient(runtime) as ChatModelFactory;
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);

  if (!paramsWithNativeOptions.messages && params.prompt.trim().length === 0) {
    throw new Error("Object generation requires a non-empty prompt");
  }

  const responseSchema = resolveResponseSchema(paramsWithNativeOptions);

  const model = openai.chat(modelName);
  const details: RecordLlmCallDetails = {
    model: modelName,
    systemPrompt: "",
    userPrompt: params.prompt,
    temperature: params.temperature ?? 0,
    maxTokens: 8192,
    purpose: "external_llm",
    actionType: "ai.generateObject",
  };
  const { object, usage } = await recordLlmCall(runtime, details, async () => {
    const repairText = getJsonRepairFunction();
    const result = responseSchema
      ? paramsWithNativeOptions.messages
        ? await generateObject({
            model,
            schema: jsonSchema(responseSchema as JSONSchema7),
            output: "object",
            messages: paramsWithNativeOptions.messages,
            experimental_repairText: repairText,
          })
        : await generateObject({
            model,
            schema: jsonSchema(responseSchema as JSONSchema7),
            output: "object",
            prompt: params.prompt,
            experimental_repairText: repairText,
          })
      : paramsWithNativeOptions.messages
        ? await generateObject({
            model,
            output: "no-schema",
            messages: paramsWithNativeOptions.messages,
            experimental_repairText: repairText,
          })
        : await generateObject({
            model,
            output: "no-schema",
            prompt: params.prompt,
            experimental_repairText: repairText,
          });
    details.response = JSON.stringify(result.object);
    if (result.usage) {
      details.promptTokens = result.usage.inputTokens ?? 0;
      details.completionTokens = result.usage.outputTokens ?? 0;
    }
    return result;
  });

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  if (typeof object !== "object" || object === null) {
    throw new Error(`Object generation returned ${typeof object}, expected object`);
  }

  return object as Record<string, JsonValue>;
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, getSmallModel);
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, getLargeModel);
}
