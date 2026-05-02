import {
  EventType,
  type IAgentRuntime,
  type ModelTypeName,
} from "@elizaos/core";
import type { LanguageModelUsage } from "ai";

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  usage: LanguageModelUsage,
) {
  const inputTokens = Number(
    (usage as { inputTokens?: number }).inputTokens || 0,
  );
  const outputTokens = Number(
    (usage as { outputTokens?: number }).outputTokens || 0,
  );
  const totalTokens = Number(
    usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens,
  );
  void runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "nvidiacloud",
    type,
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
    },
  });
}
