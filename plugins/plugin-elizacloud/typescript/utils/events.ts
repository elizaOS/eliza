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
  // Never emit the full prompt; truncate to avoid leaking secrets/PII
  const truncatedPrompt =
    typeof prompt === "string"
      ? prompt.length > 200
        ? `${prompt.slice(0, 200)}…`
        : prompt
      : "";

  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const totalTokens = Number(
    usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens,
  );

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "elizacloud",
    provider: "elizacloud",
    type,
    prompt: truncatedPrompt,
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
    },
  });
}
