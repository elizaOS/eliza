import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { getLargeModel, getSmallModel } from "../environment";
import { createCopilotProxyProvider } from "../providers";
import type { ModelName, ModelSize } from "../types";
import { emitModelUsageEvent } from "../utils/events";

interface ResolvedTextParams {
  readonly prompt: string;
  readonly stopSequences: readonly string[];
  readonly maxTokens: number;
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly frequencyPenalty: number;
  readonly presencePenalty: number;
}

function resolveTextParams(
  params: GenerateTextParams,
  modelName: ModelName,
): ResolvedTextParams {
  const prompt = params.prompt;
  const stopSequences = params.stopSequences ?? [];
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;

  const rawParams = params as unknown as Record<string, unknown>;
  const topPExplicit = "topP" in rawParams;
  const temperatureExplicit = "temperature" in rawParams;

  // OpenAI allows both temperature and topP
  const temperature: number | undefined = params.temperature ?? 0.7;
  const topP: number | undefined = params.topP;

  const defaultMaxTokens = 8192;
  const maxTokens = params.maxTokens ?? defaultMaxTokens;

  return {
    prompt,
    stopSequences,
    maxTokens,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelName: ModelName,
  modelSize: ModelSize,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
): Promise<string> {
  const copilotProxy = createCopilotProxyProvider(runtime);

  logger.log(`[CopilotProxy] Using ${modelType} model: ${modelName}`);

  const resolved = resolveTextParams(params, modelName);

  const generateParams = {
    model: copilotProxy(modelName),
    prompt: resolved.prompt,
    system: runtime.character.system ?? undefined,
    temperature: resolved.temperature,
    stopSequences: resolved.stopSequences as string[],
    frequencyPenalty: resolved.frequencyPenalty,
    presencePenalty: resolved.presencePenalty,
    maxTokens: resolved.maxTokens,
    topP: resolved.topP,
  };

  const { text, usage } = await generateText(
    generateParams as Parameters<typeof generateText>[0],
  );

  if (usage) {
    emitModelUsageEvent(runtime, modelType, resolved.prompt, usage);
  }

  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  const modelName = getSmallModel(runtime);
  return generateTextWithModel(
    runtime,
    params,
    modelName,
    "small",
    ModelType.TEXT_SMALL,
  );
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  const modelName = getLargeModel(runtime);
  return generateTextWithModel(
    runtime,
    params,
    modelName,
    "large",
    ModelType.TEXT_LARGE,
  );
}
