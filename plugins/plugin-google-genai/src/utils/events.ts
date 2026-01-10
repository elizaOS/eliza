import type { IAgentRuntime, ModelTypeName } from '@elizaos/core';
import { EventType } from '@elizaos/core';

/**
 * Emits a model usage event
 * @param runtime The runtime context
 * @param type The model type
 * @param prompt The prompt used
 * @param usage The usage data
 */
export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
) {
  runtime.emitEvent(EventType.MODEL_USED, {
    provider: 'google',
    type,
    prompt,
    tokens: {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    },
  });
}
