import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }
): void {
  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "plugin-google-genai",
    provider: "google",
    type,
    prompt,
    tokens: {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    },
  });
}
