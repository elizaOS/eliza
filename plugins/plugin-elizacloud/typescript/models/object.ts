import type { IAgentRuntime, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateObject, JSONParseError } from "ai";
import { createOpenAIClient } from "../providers/openai";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { getJsonRepairFunction } from "../utils/helpers";

/**
 * Common object generation logic for both small and large models
 */
async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: IAgentRuntime) => string,
): Promise<Record<string, unknown>> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using ${modelType} model: ${modelName}`);
  const temperature = params.temperature ?? 0;
  const schemaPresent = !!params.schema;

  if (schemaPresent) {
    logger.info(
      `Using ${modelType} without schema validation (schema provided but output=no-schema)`,
    );
  }

  try {
    const { object, usage } = await generateObject({
      model: openai.languageModel(modelName) as unknown as Parameters<
        typeof generateObject
      >[0]["model"],
      output: "no-schema",
      prompt: params.prompt,
      temperature: temperature,
      experimental_repairText: getJsonRepairFunction(),
    });

    if (usage) {
      emitModelUsageEvent(runtime, modelType as never, params.prompt, usage);
    }
    return object as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof JSONParseError) {
      logger.error(`[generateObject] Failed to parse JSON: ${error.message}`);

      const repairFunction = getJsonRepairFunction();
      const repairedJsonString = await repairFunction({
        text: error.text,
        error,
      });

      if (repairedJsonString) {
        try {
          const repairedObject = JSON.parse(repairedJsonString);
          logger.info("[generateObject] Successfully repaired JSON.");
          return repairedObject as Record<string, unknown>;
        } catch (repairParseError: unknown) {
          const message =
            repairParseError instanceof Error
              ? repairParseError.message
              : String(repairParseError);
          logger.error(
            `[generateObject] Failed to parse repaired JSON: ${message}`,
          );
          throw repairParseError;
        }
      } else {
        logger.error("[generateObject] JSON repair failed.");
        throw error;
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[generateObject] Unknown error: ${message}`);
      throw error;
    }
  }
}

/**
 * OBJECT_SMALL model handler
 */
export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_SMALL,
    getSmallModel,
  );
}

/**
 * OBJECT_LARGE model handler
 */
export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_LARGE,
    getLargeModel,
  );
}
