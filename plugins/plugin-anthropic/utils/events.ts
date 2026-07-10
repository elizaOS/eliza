/**
 * `emitModelUsageEvent` fires `EventType.MODEL_USED` after each successful
 * Anthropic call, normalizing the SDK's usage shape (prompt/completion vs
 * input/output token names, plus cache read/write counts) into the runtime's
 * usage payload so billing and telemetry consumers see one consistent record.
 * It also emits a structured prompt-cache log line (read/write token counts +
 * hit/miss classification) so operators can diagnose cache warm-up issues
 * without wiring up a MODEL_USED consumer.
 */
import type { EventPayload, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType, logger } from "@elizaos/core";

type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type NormalizedModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Classify a call's prompt-cache outcome for the structured log line.
 * - "hit": some prompt tokens were served from cache (cacheRead > 0).
 * - "write": nothing was read but a new cache entry was written — the cold
 *   first call of a prefix, or a prefix change (the miss an operator hunting
 *   cache regressions cares about).
 * - "none": the provider reported no cache activity (prefix below the
 *   model's cacheable minimum, caching disabled, or usage shape without
 *   cache fields).
 */
export function classifyPromptCacheUsage(
  cacheRead: number | undefined,
  cacheWrite: number | undefined
): "hit" | "write" | "none" {
  if (typeof cacheRead === "number" && cacheRead > 0) {
    return "hit";
  }
  if (typeof cacheWrite === "number" && cacheWrite > 0) {
    return "write";
  }
  return "none";
}

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: ModelUsage,
  modelName?: string
): NormalizedModelUsage {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
  const cacheRead = usage.cacheReadInputTokens;
  const cacheWrite = usage.cacheCreationInputTokens;
  const model = modelName?.trim() || String(type);

  // Structured prompt-cache visibility (#15742): surface cache read/write
  // counts on every call so a cold prefix ("write" with zero reads on a
  // request that was expected to hit) is diagnosable straight from the logs.
  const cacheOutcome = classifyPromptCacheUsage(cacheRead, cacheWrite);
  logger.debug(
    {
      provider: "anthropic",
      model,
      modelType: String(type),
      promptTokens,
      completionTokens,
      cacheReadInputTokens: cacheRead ?? 0,
      cacheCreationInputTokens: cacheWrite ?? 0,
      cacheOutcome,
    },
    `[Anthropic] prompt cache ${cacheOutcome}: read=${cacheRead ?? 0} write=${cacheWrite ?? 0} prompt=${promptTokens} (${model})`
  );

  runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "anthropic",
    provider: "anthropic",
    type,
    model,
    modelName: model,
    modelLabel: String(type),
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
  } as EventPayload);

  return { promptTokens, completionTokens, totalTokens };
}
