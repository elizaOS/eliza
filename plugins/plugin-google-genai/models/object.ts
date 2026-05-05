import type {
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, recordLlmCall } from "@elizaos/core";
import {
  createGoogleGenAI,
  getLargeModel,
  getSafetySettings,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string,
  getModelFn: (runtime: IAgentRuntime) => string,
): Promise<Record<string, string | number | boolean | null>> {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const modelName = getModelFn(runtime);
  const temperature = params.temperature ?? 0.1;

  logger.info(`Using ${modelType} model: ${modelName}`);

  try {
    const config = {
      temperature,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      safetySettings: getSafetySettings(),
      ...(params.schema ? { responseJsonSchema: params.schema } : {}),
    };

    const details: RecordLlmCallDetails = {
      model: modelName,
      systemPrompt: params.schema ? JSON.stringify(params.schema) : "",
      userPrompt: params.prompt,
      temperature,
      maxTokens: 8192,
      purpose: "external_llm",
      actionType: `google-genai.${modelType}.generateContent`,
    };

    const response = await recordLlmCall(runtime, details, async () => {
      const result = await genAI.models.generateContent({
        model: modelName,
        contents: params.prompt,
        config,
      });
      const responseText = result.text || "";
      details.response = responseText;
      details.promptTokens = await countTokens(params.prompt);
      details.completionTokens = await countTokens(responseText);
      return result;
    });

    const text = response.text || "";

    const promptTokens =
      details.promptTokens ?? (await countTokens(params.prompt));
    const completionTokens =
      details.completionTokens ?? (await countTokens(text));

    emitModelUsageEvent(runtime, modelType as ModelTypeName, params.prompt, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    try {
      return JSON.parse(text) as Record<
        string,
        string | number | boolean | null
      >;
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as Record<
            string,
            string | number | boolean | null
          >;
        } catch {
          throw new Error("Failed to parse JSON from response");
        }
      }
      throw new Error("Failed to parse JSON from response");
    }
  } catch (error) {
    logger.error(
      `[generateObject] Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, string | number | boolean | null>> {
  return generateObjectByModelType(
    runtime,
    params,
    "OBJECT_SMALL",
    getSmallModel,
  );
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, string | number | boolean | null>> {
  return generateObjectByModelType(
    runtime,
    params,
    "OBJECT_LARGE",
    getLargeModel,
  );
}
