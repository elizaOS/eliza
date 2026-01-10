/**
 * Event emission utilities for model usage tracking.
 */

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
 * Emit a model usage event for tracking and analytics.
 *
 * @param runtime - The agent runtime
 * @param type - The model type (e.g., TEXT_SMALL, TEXT_LARGE)
 * @param prompt - The prompt that was used
 * @param usage - The usage data from the AI SDK
 */
export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: ModelUsage,
): void {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;

  // Truncate prompt to avoid leaking secrets/PII
  const truncatedPrompt =
    typeof prompt === "string"
      ? prompt.length > 200
        ? `${prompt.slice(0, 200)}…`
        : prompt
      : "";

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
