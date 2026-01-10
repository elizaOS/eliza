import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

/**
 * Model usage data that can come in various formats from different sources
 */
type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

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
  usage: ModelUsage,
) {
  const promptTokens =
    ("promptTokens" in usage
      ? (usage as { promptTokens?: number }).promptTokens
      : undefined) ??
    ("inputTokens" in usage
      ? (usage as { inputTokens?: number }).inputTokens
      : undefined) ??
    0;
  const completionTokens =
    ("completionTokens" in usage
      ? (usage as { completionTokens?: number }).completionTokens
      : undefined) ??
    ("outputTokens" in usage
      ? (usage as { outputTokens?: number }).outputTokens
      : undefined) ??
    0;
  const totalTokens =
    ("totalTokens" in usage
      ? (usage as { totalTokens?: number }).totalTokens
      : undefined) ?? promptTokens + completionTokens;

  // Never emit the full prompt; truncate to avoid leaking secrets/PII
  const truncatedPrompt =
    typeof prompt === "string"
      ? prompt.length > 200
        ? `${prompt.slice(0, 200)}…`
        : prompt
      : "";
  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "openai",
    provider: "openai",
    type,
    prompt: truncatedPrompt,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    },
  });
}
