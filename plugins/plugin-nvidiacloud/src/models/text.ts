import type { GenerateTextParams, IAgentRuntime } from '@elizaos/core';
import { logger, ModelType } from '@elizaos/core';
import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';
import { createNvidiaOpenAI } from '../providers/nvidia';
import {
  getDefaultLargeMaxOutputTokens,
  getDefaultSmallMaxOutputTokens,
  getLargeModel,
  getSmallModel,
  getTextTimeoutMs,
} from '../utils/config';
import { emitModelUsageEvent } from '../utils/events';

type TextParams = GenerateTextParams & {
  stream?: boolean;
  onStreamChunk?: (chunk: string) => void;
};

function buildParams(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: TextParams
) {
  const { prompt } = params;
  // NVIDIA rejects `stop: []`; omit the field unless callers provide real values.
  const stopSequences = params.stopSequences?.filter((sequence) => sequence.length > 0);
  const temperature = params.temperature ?? 0.7;
  const frequencyPenalty = params.frequencyPenalty ?? 0;
  const presencePenalty = params.presencePenalty ?? 0;
  const defaultMaxOutput =
    modelType === ModelType.TEXT_SMALL
      ? getDefaultSmallMaxOutputTokens(runtime)
      : getDefaultLargeMaxOutputTokens(runtime);
  const resolvedMaxOutput =
    (params as { maxOutputTokens?: number; maxTokens?: number }).maxOutputTokens ??
    (params as { maxTokens?: number }).maxTokens ??
    defaultMaxOutput;

  const client = createNvidiaOpenAI(runtime);
  const modelName =
    modelType === ModelType.TEXT_SMALL ? getSmallModel(runtime) : getLargeModel(runtime);
  const modelLabel = modelType === ModelType.TEXT_SMALL ? 'TEXT_SMALL' : 'TEXT_LARGE';

  const generateParams: Parameters<typeof generateText>[0] = {
    model: client.chat(modelName) as LanguageModel,
    prompt,
    system: runtime.character.system ?? undefined,
    temperature,
    frequencyPenalty,
    presencePenalty,
  };
  if (stopSequences && stopSequences.length > 0) {
    generateParams.stopSequences = stopSequences;
  }
  (generateParams as { maxOutputTokens: number }).maxOutputTokens = resolvedMaxOutput;
  // WHY set an abort signal here: a stalled NIM request should not hold the
  // ElizaOS message loop open indefinitely.
  (generateParams as { abortSignal: AbortSignal }).abortSignal = AbortSignal.timeout(
    getTextTimeoutMs(runtime)
  );

  return { generateParams, modelName, modelLabel };
}

export async function handleTextSmall(runtime: IAgentRuntime, params: TextParams): Promise<string> {
  return generateWithModel(runtime, ModelType.TEXT_SMALL, params);
}

export async function handleTextLarge(runtime: IAgentRuntime, params: TextParams): Promise<string> {
  return generateWithModel(runtime, ModelType.TEXT_LARGE, params);
}

async function generateWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: TextParams
): Promise<string> {
  const { generateParams, modelName, modelLabel } = buildParams(runtime, modelType, params);
  const wantStream = params.stream === true || typeof params.onStreamChunk === 'function';

  logger.debug(`[NVIDIA NIM] ${modelLabel}: ${modelName}`);

  if (wantStream) {
    const streamResult = streamText(generateParams);
    if (params.onStreamChunk) {
      for await (const chunk of streamResult.textStream) {
        if (chunk) params.onStreamChunk(chunk);
      }
    }
    const text = await streamResult.text;
    const usage = await streamResult.usage;
    if (usage) {
      emitModelUsageEvent(runtime, modelType, usage);
    }
    return text;
  }

  try {
    const response = await generateText(generateParams);
    if (response.usage) {
      emitModelUsageEvent(runtime, modelType, response.usage);
    }
    return response.text;
  } catch (error) {
    logger.error(
      {
        error,
        model: modelName,
        modelType: modelLabel,
        timeoutMs: getTextTimeoutMs(runtime),
        maxOutputTokens: (generateParams as { maxOutputTokens: number }).maxOutputTokens,
      },
      '[NVIDIA NIM] text generation failed'
    );
    throw error;
  }
}
