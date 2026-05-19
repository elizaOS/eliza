import {
  EventType,
  type IAgentRuntime,
  type ModelEventPayload,
  type ModelTypeName,
} from "@elizaos/core";
import type { LanguageModelUsage } from "ai";

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: Partial<LanguageModelUsage> & {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }
) {
  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const totalTokens = Number(
    usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens
  );

  const payload: ModelEventPayload = {
    runtime,
    source: "elizacloud",
    type,
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
    },
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
