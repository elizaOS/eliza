/**
 * JSON object generation via Ollama + AI SDK `generateObject`.
 *
 * **Why `ollama-ai-provider-v2`:** Same stack as `text.ts`—AI SDK 5/6 requires model spec v2;
 * the legacy Ollama provider exposed v1 and failed at runtime. Object generation is less
 * exposed than chat in typical agents, but keeping one provider major line avoids “works for
 * chat, breaks for JSON object” surprises in monorepo upgrades.
 */
import type {
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
  RecordLlmCallDetails,
} from "@elizaos/core";
import { logger, ModelType, recordLlmCall } from "@elizaos/core";
import { generateObject, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import { getBaseURL, getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsed, estimateUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { ensureModelAvailable } from "./availability";

function applyUsageToDetails(details: RecordLlmCallDetails, usage: unknown): void {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) {
    return;
  }
  details.promptTokens = normalized.promptTokens;
  details.completionTokens = normalized.completionTokens;
}

async function generateOllamaObject(
  runtime: IAgentRuntime,
  ollama: ReturnType<typeof createOllama>,
  modelType: ModelTypeName,
  model: string,
  params: ObjectGenerationParams
): Promise<Record<string, string | number | boolean | null>> {
  try {
    const generateParams = {
      model: ollama(model) as LanguageModel,
      output: "no-schema" as const,
      prompt: params.prompt,
      temperature: params.temperature,
    };

    const details: RecordLlmCallDetails = {
      model,
      systemPrompt: "",
      userPrompt: params.prompt,
      temperature: params.temperature ?? 0,
      maxTokens: params.maxTokens ?? 8192,
      purpose: "external_llm",
      actionType: "ai.generateObject",
    };
    const { object, usage } = await recordLlmCall(runtime, details, async () => {
      const result = await generateObject(generateParams);
      details.response = JSON.stringify(result.object);
      applyUsageToDetails(details, result.usage);
      return result;
    });
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
