/**
 * Text generation model handlers for OpenRouter.
 */

import type { GenerateTextParams, IAgentRuntime, TextStreamResult } from '@elizaos/core';
import { logger, ModelType } from '@elizaos/core';
import { generateText, streamText } from 'ai';

import { createOpenRouterProvider } from '../providers';
import { getSmallModel, getLargeModel } from '../utils/config';
import { emitModelUsageEvent } from '../utils/events';

/**
 * Build common generation parameters for both streaming and non-streaming modes.
 */
function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: GenerateTextParams
) {
  const { prompt, stopSequences = [] } = params;
  const temperature = params.temperature ?? 0.7;
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;
  const resolvedMaxOutput =
    (params as Record<string, unknown>).maxOutputTokens ??
    (params as Record<string, unknown>).maxTokens ??
    8192;

  const openrouter = createOpenRouterProvider(runtime);
  const modelName =
    modelType === ModelType.TEXT_SMALL ? getSmallModel(runtime) : getLargeModel(runtime);
  const modelLabel = modelType === ModelType.TEXT_SMALL ? 'TEXT_SMALL' : 'TEXT_LARGE';

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

/**
 * Handle streaming text generation.
 */
function handleStreamingGeneration(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  generateParams: Record<string, unknown>,
  prompt: string,
  modelLabel: string
): TextStreamResult {
  logger.debug(`[OpenRouter] Streaming text with ${modelLabel} model`);

  const streamResult = streamText(generateParams as unknown as Parameters<typeof streamText>[0]);

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

/**
 * Common text generation logic for both small and large models.
 */
async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const { generateParams, modelName, modelLabel, prompt } = buildGenerateParams(
    runtime,
    modelType,
    params
  );

  logger.debug(`[OpenRouter] Generating text with ${modelLabel} model: ${modelName}`);

  // Handle streaming mode
  if (params.stream) {
    return handleStreamingGeneration(runtime, modelType, generateParams, prompt, modelLabel);
  }

  // Non-streaming mode
  const response = await generateText(generateParams as unknown as Parameters<typeof generateText>[0]);

  if (response.usage) {
    emitModelUsageEvent(runtime, modelType, prompt, response.usage);
  }

  return response.text;
}

/**
 * TEXT_SMALL model handler.
 *
 * @returns `string` for simple text generation, `TextStreamResult` for streaming
 */
export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_SMALL, params);
}

/**
 * TEXT_LARGE model handler.
 *
 * @returns `string` for simple text generation, `TextStreamResult` for streaming
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_LARGE, params);
}
