/**
 * Usage-accounting helpers shared by the OpenAI-compatible
 * `/v1/chat/completions` and Anthropic-compatible `/v1/messages` routes.
 */

import type { AIUsage } from "@elizaos/cloud-shared/lib/services/ai-billing";
import type { StepResult, ToolSet } from "ai";

/**
 * The abort-settlement helpers only read `usage` off the SDK's finished steps.
 * `StepResult` is invariant in its tools generic, so this structural view lets
 * a concrete `StepResult<convertedTools>[]` flow in without a cast (`usage`
 * itself does not depend on the tools generic).
 */
export type FinishedStepUsageSource = {
  readonly usage: StepResult<ToolSet>["usage"];
};

/** First finite number among `values`; numeric strings are parsed. */
export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Client-facing message for a provider-configuration failure. The requested
 * model id is the only detail safe to echo back — the underlying errors name
 * internal env vars and setup steps, which stay in server logs only.
 */
export function modelNotAvailableMessage(model: string): string {
  return `model '${model}' is not available on this deployment`;
}

/**
 * Sum the provider-reported usage of every finished step. Returns null when no
 * step reported any usage, so callers can distinguish "no report" from zero.
 */
export function summarizeFinishedStepUsage(
  steps: readonly FinishedStepUsageSource[],
): AIUsage | null {
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;

  for (const step of steps) {
    const usage = step.usage;
    const stepInputTokens = firstNumber(usage.inputTokens) ?? 0;
    const stepOutputTokens = firstNumber(usage.outputTokens) ?? 0;
    const stepTotalTokens =
      firstNumber(usage.totalTokens) ?? stepInputTokens + stepOutputTokens;
    const stepCacheReadTokens =
      firstNumber(
        usage.inputTokenDetails?.cacheReadTokens,
        usage.cachedInputTokens,
      ) ?? 0;
    const stepCacheWriteTokens =
      firstNumber(usage.inputTokenDetails?.cacheWriteTokens) ?? 0;

    if (
      stepInputTokens > 0 ||
      stepOutputTokens > 0 ||
      stepTotalTokens > 0 ||
      stepCacheReadTokens > 0 ||
      stepCacheWriteTokens > 0
    ) {
      sawUsage = true;
    }

    inputTokens += stepInputTokens;
    outputTokens += stepOutputTokens;
    totalTokens += stepTotalTokens;
    cacheReadInputTokens += stepCacheReadTokens;
    cacheWriteInputTokens += stepCacheWriteTokens;
  }

  if (!sawUsage) return null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  };
}
