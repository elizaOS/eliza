import type { GenerateTextParams, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type LanguageModelUsage, streamText } from "ai";
import { createOpenAIClient } from "../providers";
import type { TextStreamResult, TokenUsage } from "../types";
import { getExperimentalTelemetry, getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

type ModelNameGetter = (runtime: IAgentRuntime) => string;

function convertUsage(usage: LanguageModelUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

async function generateTextByModelType(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter
): Promise<string | TextStreamResult> {
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);

  const systemPrompt = runtime.character.system ?? undefined;
  const model = openai.chat(modelName);
  const generateParams = {
    model,
    prompt: params.prompt,
    system: systemPrompt,
    maxOutputTokens: params.maxTokens ?? 8192,
    experimental_telemetry: { isEnabled: getExperimentalTelemetry(runtime) },
  };

  if (params.stream) {
    const result = streamText(generateParams);
    return {
      textStream: result.textStream,
      text: Promise.resolve(result.text),
      usage: Promise.resolve(result.usage).then(convertUsage),
      finishReason: Promise.resolve(result.finishReason).then((r) => r as string | undefined),
    };
  }

  const { text, usage } = await generateText(generateParams);

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ModelType.TEXT_SMALL, getSmallModel);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ModelType.TEXT_LARGE, getLargeModel);
}
