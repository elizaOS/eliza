/**
 * Normalizes AI SDK token usage (prompt/completion or input/output naming) and
 * emits `EventType.MODEL_USED` so the runtime can meter each z.ai call.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  usage: ModelUsage
): void {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "zai",
    type,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    },
  });
}
