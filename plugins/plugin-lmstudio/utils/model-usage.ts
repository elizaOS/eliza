/**
 * Token usage normalization and `MODEL_USED` event emission for LM Studio calls.
 *
 * LM Studio's OpenAI-compatible API returns usage with the same field names as
 * OpenAI (`prompt_tokens`, `completion_tokens`, `total_tokens`), while the AI SDK
 * normalizes them to `inputTokens` / `outputTokens` / `totalTokens` before handing
 * them to us. We accept either shape and fall back to a length-based estimate when
 * a model omits usage (some local builds do).
 */

import type { EventPayload, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type NormalizedUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value));
}

export function normalizeTokenUsage(usage: unknown): NormalizedUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const record = usage as ProviderUsage;
  const promptTokens = toFiniteNumber(record.inputTokens ?? record.promptTokens);
  const completionTokens = toFiniteNumber(record.outputTokens ?? record.completionTokens);
  const totalTokens = toFiniteNumber(record.totalTokens);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return null;
  }

  const normalizedPromptTokens =
    promptTokens ??
    (completionTokens === undefined && totalTokens !== undefined
      ? totalTokens
      : Math.max(0, (totalTokens ?? 0) - (completionTokens ?? 0)));
  const normalizedCompletionTokens =
    completionTokens ??
    Math.max(0, (totalTokens ?? normalizedPromptTokens) - normalizedPromptTokens);

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: totalTokens ?? normalizedPromptTokens + normalizedCompletionTokens,
  };
}

export function estimateTokenCount(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function stringifyForUsage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function estimateUsage(prompt: string, response: unknown): NormalizedUsage {
  const promptTokens = estimateTokenCount(prompt);
  const completionTokens = estimateTokenCount(stringifyForUsage(response));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export function estimateEmbeddingUsage(text: string): NormalizedUsage {
  const promptTokens = estimateTokenCount(text);
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    estimated: true,
  };
}

export function emitModelUsed(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  model: string,
  usage: NormalizedUsage
): void {
  void runtime.emitEvent(
    EventType.MODEL_USED as string,
    {
      runtime,
      source: "lmstudio",
      provider: "lmstudio",
      type,
      model,
      modelName: model,
      tokens: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
        ...(usage.estimated ? { estimated: true } : {}),
      },
      ...(usage.estimated ? { usageEstimated: true } : {}),
    } as EventPayload
  );
}
