/**
 * Emits `EventType.MODEL_USED` after a NEAR AI inference call, normalising the
 * AI SDK's varying usage shape (prompt/completion vs input/output tokens) into
 * a `{ prompt, completion, total }` count for downstream billing/telemetry.
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
    source: "nearai",
    type,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    },
  });
}
