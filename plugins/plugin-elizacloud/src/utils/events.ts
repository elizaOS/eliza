import {
  EventType,
  type IAgentRuntime,
  type ModelEventPayload,
  type ModelTypeName,
} from "@elizaos/core";

/**
 * Extra metadata that rides along with a {@link ModelEventPayload} so that
 * downstream consumers (e.g. the waifu metering bridge) can attribute spend
 * to a concrete model id and, when the cloud surfaces it, the authoritative
 * post-markup USD cost it just debited from the org's credit balance.
 *
 * These are additive fields layered onto the standard payload — the core
 * {@link ModelEventPayload} shape is unchanged for every other listener.
 */
export interface ModelUsageEventMeta {
  /** Resolved provider model id, e.g. "anthropic/claude-opus-4.7". */
  modelName?: string;
  /**
   * Authoritative USD cost the metered gateway charged for this call, when
   * available (e.g. from a `usage.cost_usd` field or `X-Eliza-Cost-Usd`
   * response header). Undefined when the cloud does not surface it; consumers
   * then fall back to a token-based estimate.
   */
  costUsd?: number;
}

export type ModelUsageEventPayload = ModelEventPayload & ModelUsageEventMeta;

/**
 * Token counts in the naming this event contract reads. `inputTokens` and
 * `outputTokens` are REQUIRED so a native usage object shaped with
 * `promptTokens`/`completionTokens` (see NativeTokenUsage in models/text.ts) is
 * rejected at compile time instead of silently collapsing to 0 (#27732). Native
 * callers map through `toUsageEventTokens` before emitting; `totalTokens` is
 * derived from the pair when omitted.
 */
export interface ModelUsageEventTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  _prompt: string,
  usage: ModelUsageEventTokens,
  meta: ModelUsageEventMeta = {}
) {
  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const totalTokens = Number(
    usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens
  );

  const payload: ModelUsageEventPayload = {
    runtime,
    source: "elizacloud",
    type,
    tokens: {
      prompt: inputTokens,
      completion: outputTokens,
      total: totalTokens,
    },
    ...(meta.modelName ? { modelName: meta.modelName } : {}),
    ...(typeof meta.costUsd === "number" && Number.isFinite(meta.costUsd)
      ? { costUsd: meta.costUsd }
      : {}),
  };

  runtime.emitEvent(EventType.MODEL_USED, payload);
}
