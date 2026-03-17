import type {
  GenerateTextParams,
  IAgentRuntime,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type { LanguageModel } from "ai";
import { generateText, streamText } from "ai";
import { createOpenAIClient } from "../providers/openai";
import {
  getExperimentalTelemetry,
  getLargeModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: GenerateTextParams,
) {
  const { prompt, stopSequences = [] } = params;
  const temperature = params.temperature ?? 0.7;
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;
  const maxTokens = params.maxTokens ?? 8192;

  const openai = createOpenAIClient(runtime);
  const modelName =
    modelType === ModelType.TEXT_SMALL
      ? getSmallModel(runtime)
      : getLargeModel(runtime);
  const modelLabel =
    modelType === ModelType.TEXT_SMALL ? "TEXT_SMALL" : "TEXT_LARGE";
  const experimentalTelemetry = getExperimentalTelemetry(runtime);

  const model = openai.languageModel(modelName) as LanguageModel;
  // API requires every message to have content. Never send empty string for system.
  const rawSystem = runtime.character.system;
  const systemPrompt =
    rawSystem != null && String(rawSystem).trim() !== ""
      ? String(rawSystem).trim()
      : undefined; // omit system message entirely when empty

  const promptText =
    prompt != null && String(prompt).trim() !== "" ? prompt : "";
  if (promptText === "") {
    const msg =
      "[ELIZAOS_CLOUD] generateText requires a non-empty prompt (would cause 'Each message must have content'). Check state/composeState and message handler template.";
    logger.warn(msg);
    throw new Error(msg);
  }

  const generateParams = {
    model,
    prompt: promptText,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    temperature: temperature,
    maxOutputTokens: maxTokens,
    frequencyPenalty: frequencyPenalty,
    presencePenalty: presencePenalty,
    stopSequences: stopSequences,
    experimental_telemetry: {
      isEnabled: experimentalTelemetry,
    },
  };

  logger.debug(
    `[ELIZAOS_CLOUD] buildGenerateParams: model=${modelLabel}, promptLength=${promptText.length}, systemLength=${systemPrompt?.length ?? 0}`,
  );
  return { generateParams, modelName, modelLabel, prompt: promptText };
}

function handleStreamingGeneration(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  generateParams: Parameters<typeof streamText>[0],
  prompt: string,
  modelLabel: string,
): TextStreamResult {
  logger.debug(`[ELIZAOS_CLOUD] Streaming text with ${modelLabel} model`);

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
    finishReason: Promise.resolve(streamResult.finishReason) as Promise<
      string | undefined
    >,
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  const { generateParams, modelName, modelLabel, prompt } = buildGenerateParams(
    runtime,
    modelType,
    params,
  );

  logger.debug(
    `[ELIZAOS_CLOUD] Generating text with ${modelLabel} model: ${modelName}`,
  );

  if (params.stream) {
    return handleStreamingGeneration(
      runtime,
      modelType,
      generateParams,
      prompt,
      modelLabel,
    );
  }

  logger.log(`[ELIZAOS_CLOUD] Using ${modelLabel} model: ${modelName}`);
  logger.log(prompt);

  const response = await generateText(generateParams);

  if (response.usage) {
    emitModelUsageEvent(runtime, modelType, prompt, response.usage);
  }

  return response.text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_SMALL, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_LARGE, params);
}
