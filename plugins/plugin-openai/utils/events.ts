/**
 * `emitModelUsageEvent`: normalizes token-usage counts from the three shapes the
 * plugin encounters (local `TokenUsage`, AI SDK usage, raw OpenAI API usage) into
 * one payload and emits `EventType.MODEL_USED` with the complete prompt.
 */
import type { IAgentRuntime, ModelEventPayload, ModelTypeName } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import type { TokenUsage } from "../types";
import { getUsageProvider } from "./config";

/**
 * Transient-retry totals for one model call. Accumulated by the retry loops in
 * `models/text.ts` and surfaced on MODEL_USED (and the call result's
 * `providerMetadata`) so a served response that survived provider hiccups is
 * distinguishable from a clean first-attempt response — an opaque retry loop
 * hides exactly the failure signal operators need when a provider degrades.
 */
export interface ModelRetryTelemetry {
  /** Transient attempts re-issued before this call was served; 0 = first attempt. */
  retryCount: number;
  /** Provider error message behind the most recent retry, when any occurred. */
  lastRetryReason: string | undefined;
}

type OpenAIModelUsageEventPayload = ModelEventPayload & {
  source: "openai";
  prompt: string;
  retryCount?: number;
  lastRetryReason?: string;
};

interface AISDKUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** Hidden reasoning tokens the provider reports inside the output budget. */
  reasoningTokens?: number;
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}

interface OpenAIAPIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  /** Hidden reasoning tokens the provider reports inside the completion budget. */
  reasoningTokens?: number;
  promptTokensDetails?: {
    cachedTokens?: number;
  };
}

type ModelUsage = TokenUsage | AISDKUsage | OpenAIAPIUsage;

function normalizeUsage(usage: ModelUsage): TokenUsage {
  if ("promptTokens" in usage) {
    const promptTokensDetails =
      "promptTokensDetails" in usage ? usage.promptTokensDetails : undefined;
    const cachedPromptTokens = usage.cachedPromptTokens ?? promptTokensDetails?.cachedTokens;
    const reasoning = usage.reasoningTokens;
    return {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
      cachedPromptTokens,
      ...(typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0
        ? { reasoningTokens: reasoning }
        : {}),
    };
  }
  if ("inputTokens" in usage || "outputTokens" in usage) {
    const input = (usage as AISDKUsage).inputTokens ?? 0;
    const output = (usage as AISDKUsage).outputTokens ?? 0;
    const total = (usage as AISDKUsage).totalTokens ?? input + output;
    const details = (usage as AISDKUsage).outputTokenDetails;
    const reasoning = details?.reasoningTokens ?? (usage as AISDKUsage).reasoningTokens;
    return {
      promptTokens: input,
      completionTokens: output,
      totalTokens: total,
      cachedPromptTokens: (usage as AISDKUsage).cachedInputTokens,
      ...(typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0
        ? { reasoningTokens: reasoning }
        : {}),
    };
  }
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: ModelUsage,
  modelName: string,
  retry?: ModelRetryTelemetry
): void {
  const normalized = normalizeUsage(usage);
  const model = modelName.trim();
  if (!model) {
    throw new Error("MODEL_USED requires the concrete provider model name");
  }

  const payload: OpenAIModelUsageEventPayload = {
    runtime,
    source: "openai",
    provider: getUsageProvider(runtime),
    type,
    model,
    modelName: model,
    modelLabel: String(type),
    prompt,
    ...(retry
      ? {
          retryCount: retry.retryCount,
          ...(retry.lastRetryReason !== undefined
            ? { lastRetryReason: retry.lastRetryReason }
            : {}),
        }
      : {}),
    tokens: {
      prompt: normalized.promptTokens,
      completion: normalized.completionTokens,
      total: normalized.totalTokens,
      ...(normalized.cachedPromptTokens !== undefined
        ? {
            cached: normalized.cachedPromptTokens,
            cachedInputTokens: normalized.cachedPromptTokens,
            cacheReadInputTokens: normalized.cachedPromptTokens,
          }
        : {}),
      ...(normalized.reasoningTokens !== undefined
        ? { reasoningTokens: normalized.reasoningTokens }
        : {}),
    },
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
