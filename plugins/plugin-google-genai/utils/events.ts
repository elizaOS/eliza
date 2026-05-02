import type { EventPayload, IAgentRuntime, ModelTypeName } from "@elizaos/core";

const MODEL_USED_EVENT = "MODEL_USED";

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  },
): void {
  void _prompt; // Not included in ModelEventPayload
  runtime.emitEvent(MODEL_USED_EVENT, {
    runtime,
    source: "plugin-google-genai",
    type,
    tokens: {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    },
  } as EventPayload);
}
