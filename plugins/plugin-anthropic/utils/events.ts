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

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: ModelUsage
): void {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
  const cacheRead = usage.cacheReadInputTokens;
  const cacheWrite = usage.cacheCreationInputTokens;

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "anthropic",
    type,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
  } as EventPayload);
}
