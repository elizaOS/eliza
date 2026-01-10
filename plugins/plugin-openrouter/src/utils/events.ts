import {
  EventType,
  type IAgentRuntime,
  type ModelTypeName,
} from "@elizaos/core";
import type { LanguageModelUsage } from "ai";

/**
 * Emits a model usage event
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
  // Coalesce optional usage fields to stable numbers
  const inputTokens = Number((usage as { inputTokens?: number }).inputTokens || 0);
  const outputTokens = Number((usage as { outputTokens?: number }).outputTokens || 0);
  const totalTokens = Number(
    usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens,
  );
  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "openrouter",
    provider: "openrouter",
    type,
    prompt: truncatedPrompt,
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
    },
  });
}
