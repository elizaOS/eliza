import type { EventPayload, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type NormalizedModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  _prompt: string,
  usage: AIUsage,
  modelName?: string,
  modelLabel?: string
): NormalizedModelUsage {
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  const model = modelName?.trim() || modelLabel?.trim() || String(modelType);

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "openrouter",
    provider: "openrouter",
    type: modelType,
    model,
    modelName: model,
    modelLabel: modelLabel ?? String(modelType),
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
