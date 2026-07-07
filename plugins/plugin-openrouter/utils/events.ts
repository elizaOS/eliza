/**
 * Emits `EventType.MODEL_USED` after every model call, normalizing the AI SDK's
 * varied usage field names (`inputTokens`/`promptTokens`, …) into a single
 * prompt/completion/total token shape and returning it to the caller. Every
 * `models/*` handler routes its usage through here so billing/telemetry sees one
 * consistent event.
 */
import type { EventPayload, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";

interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // Cache fields: only present on the streamed-usage object the AI SDK
  // resolves after a stream finishes (`streamResult.usage`) for providers
  // that report cache reuse (e.g. Anthropic cache_control). The non-streaming
  // path already carried these through `buildNativeTextResult` in
  // models/text.ts — this interface/emitter was the streaming path's gap.
  cacheReadInputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type NormalizedModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  _prompt: string,
  usage: AIUsage,
  modelName?: string,
  modelLabel?: string
): NormalizedModelUsage {
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  const model = modelName?.trim() || modelLabel?.trim() || String(modelType);
  const cacheRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
  const cacheCreation = usage.cacheCreationInputTokens;

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "openrouter",
    provider: "openrouter",
    type: modelType,
    model,
    modelName: model,
    modelLabel: modelLabel ?? String(modelType),
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
      ...(typeof cacheRead === "number" ? { cacheReadInputTokens: cacheRead } : {}),
      ...(typeof cacheCreation === "number" ? { cacheCreationInputTokens: cacheCreation } : {}),
    },
  } as EventPayload);

  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    ...(typeof cacheRead === "number" ? { cacheReadInputTokens: cacheRead } : {}),
    ...(typeof cacheCreation === "number" ? { cacheCreationInputTokens: cacheCreation } : {}),
  };
}
