import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }
): void {
  void _prompt; // Not included in ModelEventPayload
  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "plugin-google-genai",
    type,
    tokens: {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    },
  });
}
