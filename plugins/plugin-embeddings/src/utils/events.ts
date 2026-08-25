/**
 * Emits MODEL_USED events for embedding calls so usage accounting sees the
 * provider, model type, token counts, and the complete prompt. Consumed by the
 * embedding handlers in ../models/embedding.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

interface ModelUsageEventPayload {
  runtime: IAgentRuntime;
  source: "embeddings";
  provider: "embeddings";
  type: ModelTypeName;
  prompt: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}

interface EmbeddingUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: EmbeddingUsage
): void {
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  const payload: ModelUsageEventPayload = {
    runtime,
    source: "embeddings",
    provider: "embeddings",
    type,
    prompt,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: usage.totalTokens ?? promptTokens + completionTokens,
    },
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
