import type { EventPayload, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type NormalizedModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: ModelUsage,
  modelName?: string
): NormalizedModelUsage {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
  const cacheRead = usage.cacheReadInputTokens;
  const cacheWrite = usage.cacheCreationInputTokens;
  const model = modelName?.trim() || String(type);

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "anthropic",
    provider: "anthropic",
    type,
    model,
    modelName: model,
    modelLabel: String(type),
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
  } as EventPayload);

  return { promptTokens, completionTokens, totalTokens };
}
