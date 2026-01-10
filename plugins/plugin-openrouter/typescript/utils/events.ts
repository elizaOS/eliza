/**
 * Event utilities for the OpenRouter plugin.
 */

import type { IAgentRuntime, ModelType } from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * Token usage information from AI SDK.
 */
interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Emit a model usage event for tracking.
 *
 * @param _runtime - The agent runtime (reserved for future event emission)
 * @param modelType - The type of model used
 * @param prompt - The prompt that was used
 * @param usage - Token usage information
 */
export function emitModelUsageEvent(
  _runtime: IAgentRuntime,
  modelType: typeof ModelType[keyof typeof ModelType],
  prompt: string,
  usage: AIUsage
): void {
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

  // Log usage information instead of emitting
  logger.debug({
    event: 'model:usage',
    modelType,
    provider: 'openrouter',
    prompt: prompt.substring(0, 100),
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens,
    },
    timestamp: Date.now(),
  });
}
