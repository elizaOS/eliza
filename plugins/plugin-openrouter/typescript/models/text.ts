import type { GenerateTextParams, IAgentRuntime, JsonValue, TextStreamResult } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { generateText, streamText } from "ai";

import { createOpenRouterProvider } from "../providers";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: GenerateTextParams
) {
  const { prompt, stopSequences = [] } = params;
  const temperature = params.temperature ?? 0.7;
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;
  const paramsWithMax = params as GenerateTextParams & {
    maxOutputTokens?: number;
    maxTokens?: number;
  };
  const resolvedMaxOutput = paramsWithMax.maxOutputTokens ?? paramsWithMax.maxTokens ?? 8192;

  const openrouter = createOpenRouterProvider(runtime);
  const modelName =
    modelType === ModelType.TEXT_SMALL ? getSmallModel(runtime) : getLargeModel(runtime);
  const modelLabel = modelType === ModelType.TEXT_SMALL ? "TEXT_SMALL" : "TEXT_LARGE";

  const generateParams = {
    model: openrouter.chat(modelName),
    prompt: prompt,
    system: runtime.character?.system ?? undefined,
    temperature: temperature,
    frequencyPenalty: frequencyPenalty,
    presencePenalty: presencePenalty,
    stopSequences: stopSequences,
    maxOutputTokens: resolvedMaxOutput,
  };

  return { generateParams, modelName, modelLabel, prompt };
}

function handleStreamingGeneration(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  generateParams: Record<string, JsonValue | object>,
  prompt: string,
  _modelLabel: string
): TextStreamResult {
  // @ts-expect-error - AI SDK type compatibility issue with OpenRouter provider
  const streamResult = streamText(generateParams);

  return {
    textStream: streamResult.textStream,
    text: Promise.resolve(streamResult.text),
    usage: Promise.resolve(streamResult.usage).then((usage) => {
      if (usage) {
        emitModelUsageEvent(runtime, modelType, prompt, usage);
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        return {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
      return undefined;
    }),
    finishReason: Promise.resolve(streamResult.finishReason) as Promise<string | undefined>,
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const {
    generateParams,
    modelName: _modelName,
    modelLabel,
    prompt,
  } = buildGenerateParams(runtime, modelType, params);

  if (params.stream) {
    return handleStreamingGeneration(runtime, modelType, generateParams, prompt, modelLabel);
  }

  // @ts-expect-error - AI SDK type compatibility issue with OpenRouter provider
  const response = await generateText(generateParams);

  if (response.usage) {
    emitModelUsageEvent(runtime, modelType, prompt, response.usage);
  }

  return response.text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_SMALL, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_LARGE, params);
}
