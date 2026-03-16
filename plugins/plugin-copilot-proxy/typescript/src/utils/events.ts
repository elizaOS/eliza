import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import type { LanguageModelUsage } from "ai";
import type { ModelUsageEventData } from "../types";

/**
 * Emit a model usage event for tracking and telemetry.
 */
export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  prompt: string,
  usage: LanguageModelUsage,
): void {
  const eventData: ModelUsageEventData = {
    provider: "copilot-proxy",
    type: modelType,
    prompt: prompt.substring(0, 100), // Truncate for privacy
    tokens: {
      prompt: usage.inputTokens ?? 0,
      completion: usage.outputTokens ?? 0,
      total:
        usage.totalTokens ??
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  };

  // Log event data for telemetry (no direct event emission available for custom events)
  runtime.logger.debug(
    { provider: "copilot-proxy", modelType, tokens: eventData.tokens },
    "Model usage recorded",
  );
}
