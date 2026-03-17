import type { GenerateTextParams, IAgentRuntime, PromptSegment } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  createGoogleGenAI,
  getLargeModel,
  getSafetySettings,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

/**
 * Build prompt with stable segments first when core provides promptSegments.
 * Why: Gemini uses prefix-based caching; putting stable content first maximizes cache hits.
 */
function promptForRequest(params: GenerateTextParams): string {
  const segments = params.promptSegments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return params.prompt;
  }
  return [...(segments as PromptSegment[])]
    .sort((a, b) => (a.stable === b.stable ? 0 : a.stable ? -1 : 1))
    .map((s) => s.content)
    .join("");
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const { stopSequences = [], maxTokens = 8192, temperature = 0.7 } = params;
  const prompt = promptForRequest(params);
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const modelName = getSmallModel(runtime);

  logger.log(`[TEXT_SMALL] Using model: ${modelName}`);

  try {
    const systemInstruction = runtime.character.system || undefined;
    const response = await genAI.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        temperature,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: maxTokens,
        stopSequences,
        safetySettings: getSafetySettings(),
        ...(systemInstruction && { systemInstruction }),
      },
    });

    const text = response.text || "";

    const promptTokens = await countTokens(prompt);
    const completionTokens = await countTokens(text);

    emitModelUsageEvent(runtime, ModelType.TEXT_SMALL, prompt, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    return text;
  } catch (error) {
    logger.error(`[TEXT_SMALL] Error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const { stopSequences = [], maxTokens = 8192, temperature = 0.7 } = params;
  const prompt = promptForRequest(params);
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const modelName = getLargeModel(runtime);

  logger.log(`[TEXT_LARGE] Using model: ${modelName}`);

  try {
    const systemInstruction = runtime.character.system || undefined;
    const response = await genAI.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        temperature,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: maxTokens,
        stopSequences,
        safetySettings: getSafetySettings(),
        ...(systemInstruction && { systemInstruction }),
      },
    });

    const text = response.text || "";

    const promptTokens = await countTokens(prompt);
    const completionTokens = await countTokens(text);

    emitModelUsageEvent(runtime, ModelType.TEXT_LARGE, prompt, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    return text;
  } catch (error) {
    logger.error(`[TEXT_LARGE] Error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
