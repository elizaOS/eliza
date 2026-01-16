import type {
  IAgentRuntime,
  JsonValue,
  ObjectGenerationParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type { LanguageModel } from "ai";
import { generateObject, JSONParseError } from "ai";
import { createOpenAIClient } from "../providers/openai";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { getJsonRepairFunction } from "../utils/helpers";

async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: IAgentRuntime) => string,
): Promise<Record<string, JsonValue>> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using ${modelType} model: ${modelName}`);
  const temperature = params.temperature ?? 0;

  try {
    const model = openai.languageModel(modelName) as LanguageModel;
    const { object, usage } = await generateObject({
      model,
      output: "no-schema",
      prompt: params.prompt,
      temperature: temperature,
      experimental_repairText: getJsonRepairFunction(),
    });

    if (usage) {
      emitModelUsageEvent(runtime, modelType as never, params.prompt, usage);
    }
    return object as Record<string, JsonValue>;
  } catch (error) {
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
          return repairedObject as unknown as Record<string, JsonValue>;
        } catch (repairParseError) {
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
      logger.error(`[generateObject] Error: ${message}`);
      throw error;
    }
  }
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, JsonValue>> {
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_SMALL,
    getSmallModel,
  );
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, JsonValue>> {
  return generateObjectByModelType(
    runtime,
    params,
    ModelType.OBJECT_LARGE,
    getLargeModel,
  );
}
