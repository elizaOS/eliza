/**
 * Emits MODEL_USED events for embedding calls so usage accounting sees the
 * provider, model type, token counts, and a truncated prompt (capped at
 * MAX_PROMPT_LENGTH). Consumed by the embedding handlers in ../models/embedding.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

const MAX_PROMPT_LENGTH = 200;

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

function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_LENGTH) {
    return prompt;
  }
  return `${prompt.slice(0, MAX_PROMPT_LENGTH)}…`;
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
    prompt: truncatePrompt(prompt),
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: usage.totalTokens ?? promptTokens + completionTokens,
    },
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
