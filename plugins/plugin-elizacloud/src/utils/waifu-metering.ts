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
 * back to a $5/day default estimate when no such events exist. Nothing emitted them.
 *
 * This bridge listens for the runtime `MODEL_USED` event (emitted by the cloud
 * model handlers after each inference) and POSTs a signed `inference.spent`
 * webhook to waifu's receiver (`POST /webhooks/eliza-cloud/inference`). It is
 * inactive unless the container is provisioned with the waifu metering env knobs,
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

/**
 * The MODEL_USED event `source` set by the Eliza Cloud metered inference path
 * (see ./events.ts emitModelUsageEvent). ElizaOS event dispatch is global: every
 * MODEL_USED handler receives every MODEL_USED event regardless of which plugin
 * emitted it. Only inference that actually went through the cloud metered
 * gateway debits real credits, so we must meter only those events. Other model
 * providers (e.g. plugin-local-inference emits source "local-ai" for free CPU
 * inference, plugin-openrouter emits "openrouter", etc.) must never be metered
 * as cloud burn.
 */
export const CLOUD_INFERENCE_SOURCE = "elizacloud";

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
  const webhookUrl = resolveInferenceWebhookUrl(runtime);
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
 * Resolve the inference webhook URL from the container environment.
 *
 * Prefers the explicit WAIFU_INFERENCE_WEBHOOK_URL. If that is absent but a
 * credits webhook URL (WAIFU_WEBHOOK_URL) is present, derive the sibling
 * `/inference` receiver path from the known `/credits` path. We NEVER post
 * inference events to the credits receiver: the credits mapper defaults unknown
 * payloads to `credits.topped_up`, which would corrupt credit state. If we
 * cannot safely derive an inference URL, return undefined so the bridge stays
 * disabled.
 */
export function resolveInferenceWebhookUrl(runtime: IAgentRuntime): string | undefined {
  const explicit = readEnv(runtime, "WAIFU_INFERENCE_WEBHOOK_URL");
  if (explicit) return explicit;

  const creditsUrl = readEnv(runtime, "WAIFU_WEBHOOK_URL");
  if (!creditsUrl) return undefined;

  // Only derive when the credits URL ends in a recognizable `/credits` segment.
  // Replacing the trailing `/credits` with `/inference` keeps the same host,
  // base path, and query string. Anything we cannot confidently map is treated
  // as unsafe and skipped, never reused as-is for inference.
  const derived = deriveInferenceUrlFromCredits(creditsUrl);
  if (derived) return derived;

  return undefined;
}

/**
 * Map a known `/credits` webhook URL to its sibling `/inference` URL. Returns
 * undefined when the input does not contain a `/credits` path segment, so we
 * never accidentally post inference to a non-inference endpoint.
 */
export function deriveInferenceUrlFromCredits(creditsUrl: string): string | undefined {
  try {
    const url = new URL(creditsUrl);
    if (!/\/credits\/?$/.test(url.pathname)) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/credits(\/?)$/, "/inference$1");
    return url.toString();
  } catch {
    // Fall back to a string replacement for non-absolute URLs, still requiring
    // an explicit `/credits` segment so we cannot mis-route.
    if (/\/credits\/?$/.test(creditsUrl)) {
      return creditsUrl.replace(/\/credits(\/?)$/, "/inference$1");
    }
    return undefined;
  }
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

const POST_TIMEOUT_MS = 10000;

/**
 * POST a signed `inference.spent` webhook to waifu. Best-effort: failures are
 * logged but never thrown, so metering never blocks or breaks an agent reply.
 * A 10s AbortSignal bounds the request so a stuck receiver can never leave a
 * background fetch hanging.
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
      },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
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
    const aborted = err instanceof Error && err.name === "TimeoutError";
    const detail = aborted
      ? `timed out after ${POST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    logger.warn(
      `[waifu-metering] inference.spent POST failed for agent ${config.agentId}: ${detail}`
    );
    return { ok: false };
  }
}

/**
 * Build the MODEL_USED event handler that forwards inference spend to waifu.
 * Resolves config lazily per-event so it stays inactive until the metering env
 * is present, and so config changes (rare) are picked up without a restart.
 */
export function createWaifuMeteringHandler(
  fetchImpl: typeof fetch = fetch
): (payload: ModelUsageEventPayload) => Promise<void> {
  return async (payload: ModelUsageEventPayload): Promise<void> => {
    const runtime = payload?.runtime;
    if (!runtime) return;
    // ElizaOS dispatches MODEL_USED globally to every registered handler, so we
    // also receive events from other model providers (local-ai, openrouter,
    // etc.). Only cloud-metered inference debits real credits; meter only that
    // source so we never bill free/local inference as cloud burn.
    if (payload?.source !== CLOUD_INFERENCE_SOURCE) return;
    const config = resolveWaifuMeteringConfig(runtime);
    if (!config) return;
    const spent = buildInferenceSpentPayload(config, payload);
    if (!spent) return;
    await postInferenceSpent(config, spent, fetchImpl);
  };
}
