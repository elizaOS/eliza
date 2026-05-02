import type { IAgentRuntime, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateObject, jsonSchema } from "ai";
import { createModelForName, detectProvider } from "../providers";
import { getSmallModel, getLargeModel } from "../utils/config";
import { executeWithRetry } from "../utils/retry";

async function generateObjectWithModel(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelName: string,
  modelType: string,
): Promise<Record<string, unknown>> {
  const model = createModelForName(runtime, modelName);
  const provider = detectProvider(modelName);

  logger.log(
    `[Vertex:${provider}] Object generation using ${modelType}: ${modelName}`,
  );

  const { object } = await executeWithRetry(`${modelType} object request`, () =>
    generateObject({
      model,
      messages: [{ role: "user" as const, content: params.prompt }],
      system: runtime.character.system ?? undefined,
      schema: jsonSchema(params.schema ?? { type: "object" }),
      temperature: params.temperature ?? 0.7,
      maxOutputTokens: params.maxTokens ?? 8192,
    }),
  );

  return object as Record<string, unknown>;
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithModel(
    runtime,
    params,
    getSmallModel(runtime),
    ModelType.OBJECT_SMALL,
  );
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithModel(
    runtime,
    params,
    getLargeModel(runtime),
    ModelType.OBJECT_LARGE,
  );
}
