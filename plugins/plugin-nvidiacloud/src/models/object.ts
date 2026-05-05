import type {
  IAgentRuntime,
  ObjectGenerationParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, ModelType, recordLlmCall } from "@elizaos/core";
import {
  generateObject,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import type { JSONSchema7 } from "json-schema";
import { createNvidiaOpenAI } from "../providers/nvidia";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import {
  getJsonRepairFunction,
  handleObjectGenerationError,
} from "../utils/helpers";

function applyUsageToDetails(
  details: RecordLlmCallDetails,
  usage: LanguageModelUsage | undefined,
): void {
  if (!usage) {
    return;
  }
  details.promptTokens = Number(
    (usage as { inputTokens?: number }).inputTokens || 0,
  );
  details.completionTokens = Number(
    (usage as { outputTokens?: number }).outputTokens || 0,
  );
}

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
    const systemPrompt = runtime.character.system ?? "";
    const details: RecordLlmCallDetails = {
      model: modelName,
      systemPrompt,
      userPrompt: params.prompt,
      temperature,
      maxTokens: params.maxTokens ?? 8192,
      purpose: "external_llm",
      actionType: "ai.generateObject",
    };
    const { object, usage } = await recordLlmCall(
      runtime,
      details,
      async () => {
        const result = await generateObject({
          model: client.chat(modelName) as LanguageModel,
          ...(params.schema && {
            schema: jsonSchema(params.schema as JSONSchema7),
          }),
          output: params.schema ? "object" : "no-schema",
          prompt: params.prompt,
          system: systemPrompt || undefined,
          temperature,
          experimental_repairText: getJsonRepairFunction(),
        });
        details.response = JSON.stringify(result.object);
        applyUsageToDetails(details, result.usage);
        return result;
      },
    );

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
