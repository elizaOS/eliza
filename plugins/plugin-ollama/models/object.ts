import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateObject, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider";

import { getBaseURL, getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsed, estimateUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { ensureModelAvailable } from "./availability";

async function generateOllamaObject(
  runtime: IAgentRuntime,
  ollama: ReturnType<typeof createOllama>,
  modelType: ModelTypeName,
  model: string,
  params: ObjectGenerationParams
): Promise<Record<string, string | number | boolean | null>> {
  try {
    const generateParams = {
      // ollama-ai-provider still exposes older AI SDK model interfaces.
      model: ollama(model) as unknown as LanguageModel,
      output: "no-schema" as const,
      prompt: params.prompt,
      temperature: params.temperature,
    };

    const { object, usage } = await generateObject(generateParams);
    emitModelUsed(
      runtime,
      modelType,
      model,
      normalizeTokenUsage(usage) ?? estimateUsage(params.prompt, object)
    );
    return object as Record<string, string | number | boolean | null>;
  } catch (error: unknown) {
    logger.error({ error }, "Error generating object");
    return {};
  }
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, string | number | boolean | null>> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });
    const model = getSmallModel(runtime);

    logger.log(`[Ollama] Using OBJECT_SMALL model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    return await generateOllamaObject(runtime, ollama, ModelType.OBJECT_SMALL, model, params);
  } catch (error) {
    logger.error({ error }, "Error in OBJECT_SMALL model");
    return {};
  }
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, string | number | boolean | null>> {
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });
    const model = getLargeModel(runtime);

    logger.log(`[Ollama] Using OBJECT_LARGE model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    return await generateOllamaObject(runtime, ollama, ModelType.OBJECT_LARGE, model, params);
  } catch (error) {
    logger.error({ error }, "Error in OBJECT_LARGE model");
    return {};
  }
}
