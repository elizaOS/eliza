import {
  EventType,
  type EventPayload,
  type IAgentRuntime,
  type ModelTypeName,
} from "@elizaos/core";
import type { LanguageModelUsage } from "ai";

export type NormalizedModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  usage: LanguageModelUsage,
  modelName?: string,
  modelLabel?: string,
): NormalizedModelUsage {
  const inputTokens = Number(
    (usage as { inputTokens?: number }).inputTokens || 0,
  );
  const outputTokens = Number(
    (usage as { outputTokens?: number }).outputTokens || 0,
  );
  const totalTokens = Number(
    usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens,
  );
  const model = modelName?.trim() || modelLabel?.trim() || String(type);
  void runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "nvidiacloud",
    provider: "nvidiacloud",
    type,
    model,
    modelName: model,
    modelLabel: modelLabel ?? String(type),
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
    },
  } as EventPayload);

  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
  };
}
