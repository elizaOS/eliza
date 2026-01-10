import type { IAgentRuntime, GenerateTextParams } from '@elizaos/core';
import { logger, ModelType } from '@elizaos/core';
import {
  createGoogleGenAI,
  getSafetySettings,
  getSmallModel,
  getLargeModel,
} from '../utils/config';
import { emitModelUsageEvent } from '../utils/events';
import { countTokens } from '../utils/tokenization';

export async function handleTextSmall(
  runtime: IAgentRuntime,
  {
    prompt,
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  }: GenerateTextParams
) {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error('Google Generative AI client not initialized');
  }

  const modelName = getSmallModel(runtime);

  logger.log(`[TEXT_SMALL] Using model: ${modelName}`);
  logger.debug(`[TEXT_SMALL] Prompt: ${prompt}`);

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

    const text = response.text || '';

    // Count tokens for usage tracking
    const promptTokens = await countTokens(prompt);
    const completionTokens = await countTokens(text);

    emitModelUsageEvent(runtime, ModelType.TEXT_SMALL, prompt, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    return text;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[TEXT_SMALL] Error: ${message}`);
    throw error;
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
) {
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error('Google Generative AI client not initialized');
  }

  const modelName = getLargeModel(runtime);

  logger.log(`[TEXT_LARGE] Using model: ${modelName}`);
  logger.debug(`[TEXT_LARGE] Prompt: ${prompt}`);

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

    const text = response.text || '';

    // Count tokens for usage tracking
    const promptTokens = await countTokens(prompt);
    const completionTokens = await countTokens(text);

    emitModelUsageEvent(runtime, ModelType.TEXT_LARGE, prompt, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    return text;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[TEXT_LARGE] Error: ${message}`);
    throw error;
  }
}
