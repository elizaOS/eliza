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
  prompt: string,
  usage: ModelUsage
): void {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;

  const truncatedPrompt =
    typeof prompt === "string" ? (prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt) : "";

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "anthropic",
    provider: "anthropic",
    type,
    prompt: truncatedPrompt,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    },
  });
}
