import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { generateText } from "ai";
import { createOllama } from "ollama-ai-provider";

import { getBaseURL, getLargeModel, getSmallModel } from "../utils/config";
import { ensureModelAvailable } from "./availability";

async function generateOllamaText(
  ollama: ReturnType<typeof createOllama>,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
  }
): Promise<string> {
  try {
    const generateParams = {
      model: ollama(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences,
    };

    const { text: ollamaResponse } = await generateText(generateParams);
    return ollamaResponse;
  } catch (error: unknown) {
    logger.error({ error }, "Error in generateOllamaText");
    return "Error generating text. Please try again later.";
  }
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  { prompt, stopSequences = [] }: GenerateTextParams
): Promise<string> {
  try {
    const temperature = 0.7;
    const frequency_penalty = 0.7;
    const presence_penalty = 0.7;
    const max_response_length = 8000;

    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    const model = getSmallModel(runtime);
    logger.log(`[Ollama] Using TEXT_SMALL model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    return await generateOllamaText(ollama, model, {
      prompt,
      system: runtime.character?.system ?? undefined,
      temperature,
      maxTokens: max_response_length,
      frequencyPenalty: frequency_penalty,
      presencePenalty: presence_penalty,
      stopSequences,
    });
  } catch (error) {
    logger.error({ error }, "Error in TEXT_SMALL model");
    return "Error generating text. Please try again later.";
  }
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  {
    prompt,
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  }: GenerateTextParams
): Promise<string> {
  try {
    const model = getLargeModel(runtime);
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    logger.log(`[Ollama] Using TEXT_LARGE model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);
    return await generateOllamaText(ollama, model, {
      prompt,
      system: runtime.character?.system ?? undefined,
      temperature,
      maxTokens,
      frequencyPenalty,
      presencePenalty,
      stopSequences,
    });
  } catch (error) {
    logger.error({ error }, "Error in TEXT_LARGE model");
    return "Error generating text. Please try again later.";
  }
}
