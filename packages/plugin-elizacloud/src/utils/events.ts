import {
  EventType,
  type IAgentRuntime,
  type ModelTypeName,
} from "@elizaos/core";
import type { LanguageModelUsage } from "ai";

/**
 * Emits a model usage event
 * @param runtime The runtime context
 * @param type The model type
 * @param prompt The prompt used
 * @param usage The LLM usage data
 */
export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: LanguageModelUsage,
) {
  runtime.emitEvent(EventType.MODEL_USED, {
    provider: "openai",
    type,
    prompt,
    tokens: {
      prompt: usage.inputTokens,
      completion: usage.outputTokens,
      total: usage.totalTokens,
    },
  });
}
