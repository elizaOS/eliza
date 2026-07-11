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
  // Legacy/direct-set cache fields: some non-AI-SDK callers (or older SDK
  // versions) set these directly. Real `ai@^6` results never populate
  // `cacheCreationInputTokens` — see `inputTokenDetails` below.
  cacheReadInputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  // The AI SDK's actual home for cache token counts (`ai@^6`
  // `LanguageModelUsage.inputTokenDetails`, `node_modules/ai/dist/index.js`
  // `convertUsage`). `cacheReadTokens` duplicates the deprecated top-level
  // `cachedInputTokens`; `cacheWriteTokens` has no top-level alias at all —
  // reading only `cacheCreationInputTokens` (which the SDK never sets)
  // silently dropped every cache-write count reported by Anthropic-family
  // models routed through OpenRouter.
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export type NormalizedModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

/**
 * Reads cache read/write token counts off an AI SDK usage object, preferring
 * the SDK's real `inputTokenDetails` location and falling back to the
 * legacy/direct fields for callers that set them explicitly.
 */
export function extractCacheTokens(usage: AIUsage): {
  cacheRead?: number;
  cacheCreation?: number;
} {
  const cacheRead =
    usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens;
  const cacheCreation = usage.cacheCreationInputTokens ?? usage.inputTokenDetails?.cacheWriteTokens;
  return { cacheRead, cacheCreation };
}

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
  const { cacheRead, cacheCreation } = extractCacheTokens(usage);

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
