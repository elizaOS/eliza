import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type LanguageModelUsage, streamText } from "ai";
import { createOpenAIClient } from "../providers";
import {
  getExperimentalTelemetry,
  getLargeModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

async function generateTextByModelType(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName,
  getModelFn: (runtime: IAgentRuntime) => string,
): Promise<string | TextStreamResult> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] ${modelType} model: ${modelName}`);

  const generateParams = {
    model: openai.languageModel(modelName),
    prompt: params.prompt,
    system: runtime.character.system ?? undefined,
    temperature: params.temperature ?? 0.7,
    maxOutputTokens: params.maxTokens ?? 8192,
    frequencyPenalty: params.frequencyPenalty ?? 0.7,
    presencePenalty: params.presencePenalty ?? 0.7,
    stopSequences: params.stopSequences ?? [],
    experimental_telemetry: { isEnabled: getExperimentalTelemetry(runtime) },
  };

  // Streaming mode
  if (params.stream) {
    const result = streamText(generateParams);
    return {
      textStream: result.textStream,
      text: Promise.resolve(result.text),
      usage: Promise.resolve(result.usage).then((u: LanguageModelUsage | undefined) =>
        u
          ? {
              promptTokens: u.inputTokens ?? 0,
              completionTokens: u.outputTokens ?? 0,
              totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            }
          : undefined,
      ),
      finishReason: Promise.resolve(result.finishReason).then((r) => r ?? undefined),
    };
  }

  // Non-streaming mode
  const { text, usage } = await generateText(generateParams);
  if (usage) emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  return text;
}

/**
 * TEXT_SMALL model handler
 */
export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextByModelType(
    runtime,
    params,
    ModelType.TEXT_SMALL,
    getSmallModel,
  );
}

/**
 * TEXT_LARGE model handler
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextByModelType(
    runtime,
    params,
    ModelType.TEXT_LARGE,
    getLargeModel,
  );
}
