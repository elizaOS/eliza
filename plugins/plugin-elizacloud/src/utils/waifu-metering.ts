/**
 * Waifu metering bridge.
 *
 * A hosted waifu agent runs as a sandboxed container whose model inference is
 * routed through the Eliza Cloud metered inference gateway. The gateway is the
 * honest meter: it owns the per-model pricing table and the platform markup,
 * and it debits the organization's credit balance on every call. That debit is
 * authoritative and already happens server-side.
 *
 * What was missing is the *signal back to waifu*: waifu's burn rollup
 * (`apps/worker/src/processors/agent-rollup.ts`) reads `inference.spent`
 * agent_events to compute `agentDailyBurnUsd` / `agentRunwayDays`, but falls
 * back to a $5/day placeholder when no such events exist. Nothing emitted them.
 *
 * This bridge listens for the runtime `MODEL_USED` event (emitted by the cloud
 * model handlers after each inference) and POSTs a signed `inference.spent`
 * webhook to waifu's receiver (`POST /webhooks/eliza-cloud/inference`). It is a
 * no-op unless the container is provisioned with the waifu metering env knobs,
 * so it never fires for non-hosted (local dev / standalone) agents.
 *
 * Token counts are exact (reported by the gateway). USD is the authoritative
 * post-markup cost when the gateway surfaces it (`usage.cost_usd` /
 * `X-Eliza-Cost-Usd`); otherwise a conservative token-based estimate is used,
 * configurable per-model via WAIFU_METER_USD_PER_1K_INPUT / _OUTPUT. The credit
 * debit itself is always the cloud's authoritative number; the estimate only
 * affects waifu's burn display until the cloud cost is wired through.
 */

import crypto from "node:crypto";
import { type IAgentRuntime, logger } from "@elizaos/core";
import type { ModelUsageEventPayload } from "./events";

const DEFAULT_USD_PER_1K_INPUT = 0.003;
const DEFAULT_USD_PER_1K_OUTPUT = 0.015;

export interface WaifuMeteringConfig {
  webhookUrl: string;
  secret: string;
  agentId: string;
  usdPer1kInput: number;
  usdPer1kOutput: number;
}

function readEnv(runtime: IAgentRuntime, key: string): string | undefined {
  const fromSettings =
    typeof runtime.getSetting === "function" ? runtime.getSetting(key) : undefined;
  const value =
    (typeof fromSettings === "string" && fromSettings) ||
    (typeof process !== "undefined" ? process.env?.[key] : undefined);
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumberEnv(
  runtime: IAgentRuntime,
  key: string,
  fallback: number
): number {
  const raw = readEnv(runtime, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolve the metering config from the container environment. Returns null
 * (bridge disabled) when the required knobs are absent, which is the case for
 * any agent that is not a hosted waifu agent.
 */
export function resolveWaifuMeteringConfig(
  runtime: IAgentRuntime
): WaifuMeteringConfig | null {
  const webhookUrl =
    readEnv(runtime, "WAIFU_INFERENCE_WEBHOOK_URL") ?? readEnv(runtime, "WAIFU_WEBHOOK_URL");
  const secret =
    readEnv(runtime, "WAIFU_WEBHOOK_SECRET") ?? readEnv(runtime, "WAIFU_INFERENCE_WEBHOOK_SECRET");
  const agentId = readEnv(runtime, "WAIFU_AGENT_ID") ?? readEnv(runtime, "WAIFU_CORE_AGENT_ID");

  if (!webhookUrl || !secret || !agentId) {
    return null;
  }

  return {
    webhookUrl,
    secret,
    agentId,
    usdPer1kInput: readNumberEnv(runtime, "WAIFU_METER_USD_PER_1K_INPUT", DEFAULT_USD_PER_1K_INPUT),
    usdPer1kOutput: readNumberEnv(
      runtime,
      "WAIFU_METER_USD_PER_1K_OUTPUT",
      DEFAULT_USD_PER_1K_OUTPUT
    ),
  };
}

/**
 * HMAC signature compatible with waifu's webhook receiver:
 * `sha256=` + HMAC-SHA256 over `${timestamp}.${rawBody}`.
 */
export function signWaifuWebhook(rawBody: string, timestamp: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function estimateUsd(
  config: WaifuMeteringConfig,
  inputTokens: number,
  outputTokens: number
): number {
  const usd =
    (inputTokens / 1000) * config.usdPer1kInput +
    (outputTokens / 1000) * config.usdPer1kOutput;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

export interface InferenceSpentPayload {
  agentId: string;
  modelType: string;
  modelName?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
  costSource: "gateway" | "estimate";
  timestamp: string;
  idempotencyKey: string;
  source: "elizacloud";
}

export function buildInferenceSpentPayload(
  config: WaifuMeteringConfig,
  event: ModelUsageEventPayload,
  now: Date = new Date()
): InferenceSpentPayload | null {
  const promptTokens = Math.max(0, Math.round(Number(event.tokens?.prompt ?? 0)));
  const completionTokens = Math.max(0, Math.round(Number(event.tokens?.completion ?? 0)));
  const totalTokens = Math.max(
    0,
    Math.round(Number(event.tokens?.total ?? promptTokens + completionTokens))
  );

  // Nothing was actually spent (e.g. a cached/short-circuited call with no
  // tokens). Skip so we never inflate the burn with empty events.
  if (totalTokens === 0 && promptTokens === 0 && completionTokens === 0) {
    return null;
  }

  const gatewayCost =
    typeof event.costUsd === "number" && Number.isFinite(event.costUsd) && event.costUsd >= 0
      ? event.costUsd
      : undefined;
  const usd = gatewayCost ?? estimateUsd(config, promptTokens, completionTokens);

  const timestamp = now.toISOString();
  return {
    agentId: config.agentId,
    modelType: String(event.type ?? "unknown"),
    ...(event.modelName ? { modelName: event.modelName } : {}),
    promptTokens,
    completionTokens,
    totalTokens,
    usd,
    costSource: gatewayCost !== undefined ? "gateway" : "estimate",
    timestamp,
    idempotencyKey: `inference:${config.agentId}:${crypto.randomUUID()}`,
    source: "elizacloud",
  };
}

/**
 * POST a signed `inference.spent` webhook to waifu. Best-effort: failures are
 * logged but never thrown, so metering never blocks or breaks an agent reply.
 */
export async function postInferenceSpent(
  config: WaifuMeteringConfig,
  payload: InferenceSpentPayload,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status?: number }> {
  const body = JSON.stringify(payload);
  const signature = signWaifuWebhook(body, payload.timestamp, config.secret);
  try {
    const res = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Waifu-Webhook-Signature": signature,
        "X-Waifu-Signature": signature,
      },
      body,
    });
    if (!res.ok) {
      logger.warn(
        `[waifu-metering] inference.spent POST returned ${res.status} for agent ${config.agentId}`
      );
      return { ok: false, status: res.status };
    }
    logger.debug(
      `[waifu-metering] inference.spent posted (agent=${config.agentId} tokens=${payload.totalTokens} usd=${payload.usd.toFixed(6)} src=${payload.costSource})`
    );
    return { ok: true, status: res.status };
  } catch (err) {
    logger.warn(
      `[waifu-metering] inference.spent POST failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false };
  }
}

/**
 * Build the MODEL_USED event handler that forwards inference spend to waifu.
 * Resolves config lazily per-event so it stays a no-op until the metering env
 * is present, and so config changes (rare) are picked up without a restart.
 */
export function createWaifuMeteringHandler(
  fetchImpl: typeof fetch = fetch
): (payload: ModelUsageEventPayload) => Promise<void> {
  return async (payload: ModelUsageEventPayload): Promise<void> => {
    const runtime = payload?.runtime;
    if (!runtime) return;
    const config = resolveWaifuMeteringConfig(runtime);
    if (!config) return;
    const spent = buildInferenceSpentPayload(config, payload);
    if (!spent) return;
    await postInferenceSpent(config, spent, fetchImpl);
  };
}
