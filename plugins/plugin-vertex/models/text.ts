import type {
  GenerateTextParams,
  IAgentRuntime,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, streamText } from "ai";
import { createModelForName, detectProvider } from "../providers";
import { executeWithRetry, formatModelError } from "../utils/retry";
import {
  getSmallModel,
  getLargeModel,
  getReasoningSmallModel,
  getReasoningLargeModel,
} from "../utils/config";
import {
  emitModelUsed,
  estimateUsage,
  normalizeTokenUsage,
  toCoreTokenUsage,
} from "../utils/modelUsage";

function isOpus4Model(name: string): boolean {
  return name.toLowerCase().includes("opus-4");
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelName: string,
  modelType: string,
): Promise<string | TextStreamResult> {
  const model = createModelForName(runtime, modelName);
  const provider = detectProvider(modelName);

  let temperature = params.temperature ?? 0.7;
  if (isOpus4Model(modelName) && temperature !== 1) {
    temperature = 1;
  }

  const defaultMaxTokens = 8192;
  const maxTokens = Math.min(
    params.maxTokens ?? defaultMaxTokens,
    isOpus4Model(modelName) ? 32_000 : 64_000,
  );

  logger.log(`[Vertex:${provider}] Using ${modelType}: ${modelName}`);

  const generateParams = {
    model,
    messages: [{ role: "user" as const, content: params.prompt }],
    system: runtime.character.system ?? undefined,
    temperature,
    maxOutputTokens: maxTokens,
    stopSequences: (params.stopSequences ?? []) as string[],
  };

  if (params.stream) {
    try {
      const streamResult = streamText(generateParams);
      const text = Promise.resolve(streamResult.text);
      const usage = Promise.resolve(streamResult.usage).then(
        async (providerUsage) => {
          const normalizedUsage =
            normalizeTokenUsage(providerUsage) ??
            estimateUsage(params.prompt, await text);
          emitModelUsed(
            runtime,
            modelType,
            modelName,
            normalizedUsage,
            provider,
          );
          return toCoreTokenUsage(normalizedUsage);
        },
      );
      return {
        textStream: streamResult.textStream,
        text,
        usage,
        finishReason: Promise.resolve(streamResult.finishReason) as Promise<
          string | undefined
        >,
      };
    } catch (error) {
      throw formatModelError(`${modelType} stream`, error);
    }
  }

  const { text, usage } = await executeWithRetry(`${modelType} request`, () =>
    generateText(generateParams),
  );
  emitModelUsed(
    runtime,
    modelType,
    modelName,
    normalizeTokenUsage(usage) ?? estimateUsage(params.prompt, text),
    provider,
  );
  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getSmallModel(runtime),
    ModelType.TEXT_SMALL,
  );
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getLargeModel(runtime),
    ModelType.TEXT_LARGE,
  );
}

export async function handleReasoningSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getReasoningSmallModel(runtime),
    "TEXT_REASONING_SMALL",
  );
}

export async function handleReasoningLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getReasoningLargeModel(runtime),
    "TEXT_REASONING_LARGE",
  );
}
