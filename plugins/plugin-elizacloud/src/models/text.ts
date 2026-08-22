/**
 * Eliza Cloud text-model handlers for Responses API calls and native
 * OpenAI-compatible chat completions. The native path preserves tool identity,
 * validates structured inputs, and exposes streaming results to the runtime.
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
  TokenUsage,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  DEFAULT_CEREBRAS_TEXT_MODEL,
  ElizaError,
  logger,
  ModelType,
  recordInferenceSpan,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
  Semaphore,
  timeInferenceSpan,
} from "@elizaos/core";
import {
  recordGatewayResponseTelemetry,
  withInferenceTraceHeader,
} from "../utils/trace-correlation";
import {
  getActionPlannerModel,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { extractResponsesOutputText } from "../utils/responses-output";
import { createCloudApiClient } from "../utils/sdk-client";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_SMALL_MODEL_TYPE = ModelType.TEXT_SMALL;
const TEXT_LARGE_MODEL_TYPE = ModelType.TEXT_LARGE;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

/**
 * Per-process cap on CONCURRENT native cloud text calls.
 *
 * Covers BOTH native cloud text routes that share the one cerebras key:
 * the `/chat/completions` round-trip (native-transport callers) AND the
 * `/responses` round-trip (bare-`{ prompt }` callers, incl. the primary reply
 * action). Same model name -> same shared key -> same concurrency budget, so
 * both routes must funnel through this one semaphore or a bare-prompt call can
 * still push the key over its limit.
 *
 * The per-turn burst that triggers the 429 comes from the prompt BATCHER
 * (`dynamicPromptExecFromState`, which always sets providerOptions -> native
 * `/chat/completions`) and the merged evaluator call — NOT from composeState
 * providers (no provider calls `useModel` during composeState). Firing those
 * at once overruns the ONE shared cerebras key's concurrent-request limit
 * -> 429 -> 3 retries x backoff -> 30-63s of latency. Capping in-flight calls
 * through a small semaphore keeps each call ~3s with no 429, without needing
 * more keys or backend changes.
 *
 * Default is a SAFETY CEILING, not full serialization: the paid cerebras key
 * (1000 req/min) and leaner per-turn call counts make the 429 risk small, so
 * the default of 8 leaves the typical 1-3 concurrent calls/turn untouched while
 * still bounding a pathological burst. The limiter is process-global and keys
 * on native transport, not the model, so it also bounds non-cerebras native
 * calls (e.g. zai-glm-4.7) — a high default avoids serializing those. Set
 * `ELIZAOS_CLOUD_NATIVE_CONCURRENCY` (positive integer) to tighten it (1 = fully
 * serialize) on a cerebras-bottlenecked single-key deployment, or raise it for
 * more parallelism. Embeddings use a SEPARATE `/embeddings` route
 * (embeddings.ts) and are intentionally NOT gated here.
 */
const NATIVE_CONCURRENCY_ENV = "ELIZAOS_CLOUD_NATIVE_CONCURRENCY";
const DEFAULT_NATIVE_CONCURRENCY = 8;

/**
 * Client-side timeout for cloud text round-trips. Without this the handler
 * passes no `timeoutMs`/`signal` to `requestRaw`, so a hung/slow gateway holds
 * the concurrency permit AND stalls the whole turn until fetch's own (very
 * long) default. `ELIZAOS_CLOUD_TEXT_TIMEOUT_MS` overrides; `0`/negative opts
 * out (no client-side timeout).
 */
const TEXT_TIMEOUT_ENV = "ELIZAOS_CLOUD_TEXT_TIMEOUT_MS";
const DEFAULT_TEXT_TIMEOUT_MS = 120_000;

export function resolveTextTimeoutMs(): number | undefined {
  const raw =
    typeof process !== "undefined" ? process.env[TEXT_TIMEOUT_ENV] : undefined;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TEXT_TIMEOUT_MS;
  // `Number.parseInt` stops at the first non-digit, so "500junk" parsed to 500
  // and became a 500ms client timeout instead of the documented fallback. The
  // sign is accepted here on purpose: this setting documents `0`/negative as
  // the opt-out, so the `<= 0` check below stays the range authority.
  const parsed = /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) return DEFAULT_TEXT_TIMEOUT_MS;
  return parsed <= 0 ? undefined : parsed;
}

/**
 * Token-by-token streaming of the native `/chat/completions` round-trip. On by
 * default so the user-visible reply renders from the first token instead of
 * waiting for the whole generation. `ELIZAOS_CLOUD_STREAMING=0`/`false`/`off`
 * forces the buffered path (kill-switch). Streaming only engages when the
 * runtime actually requests it (`params.stream`), so non-streaming callers
 * (connectors with no UI stream) are unaffected.
 */
const STREAMING_ENV = "ELIZAOS_CLOUD_STREAMING";

export function resolveStreamingEnabled(): boolean {
  const raw = typeof process !== "undefined" ? process.env[STREAMING_ENV] : undefined;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/**
 * Combine the runtime's abort signal with the client-side timeout into one
 * signal for `requestRaw`. A stream is long-lived, so it should abort on EITHER
 * a caller cancel OR the timeout — `requestRaw` honors only a single signal, so
 * merge them here.
 */
export function buildStreamAbortSignal(
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): AbortSignal | undefined {
  const timeoutSig =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (abortSignal && timeoutSig) return AbortSignal.any([abortSignal, timeoutSig]);
  return abortSignal ?? timeoutSig;
}

let nativeChatLimiter: Semaphore | null = null;

function resolveNativeConcurrency(): number {
  const raw =
    typeof process !== "undefined" ? process.env[NATIVE_CONCURRENCY_ENV] : undefined;
  // Same prefix-parse hole as the timeout above: "2junk" parsed to 2 and
  // silently tightened the semaphore from 8. The `> 0` check stays the range
  // authority, so a signed value is still parsed and then judged by it.
  const parsed =
    raw && /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_NATIVE_CONCURRENCY;
}

function getNativeChatLimiter(): Semaphore {
  if (!nativeChatLimiter) {
    nativeChatLimiter = new Semaphore(resolveNativeConcurrency());
  }
  return nativeChatLimiter;
}

/**
 * Run a single cerebras-bound network round-trip under the shared per-process
 * concurrency cap. Hold the permit only across `fn` (the `requestRaw` call);
 * release the instant the server responds so response-body parsing runs
 * unguarded. `finally` frees the permit even on throw so a failed call never
 * starves the queue. Used by BOTH native text routes (`/chat/completions` and
 * `/responses`) so every cerebras text call shares one budget.
 *
 * Exported for unit tests that drive the shared cap directly.
 *
 * `label` (e.g. `responses` / `chat/completions`) tags the latency spans this
 * records on the active per-turn inference timer: `cloud.semaphore-wait` (time
 * spent queued for a permit — non-zero means the cap is serializing) and
 * `cloud.http:<label>` (the network round-trip). Both are no-ops when no turn
 * timer is active.
 */
export async function withNativeChatLimit<T>(
  fn: () => Promise<T>,
  label = "native"
): Promise<T> {
  const limiter = getNativeChatLimiter();
  const waitStartedAt = Date.now();
  await limiter.acquire();
  recordInferenceSpan("cloud.semaphore-wait", Date.now() - waitStartedAt, {
    route: label,
  });
  try {
    return await timeInferenceSpan(`cloud.http:${label}`, fn, { route: label });
  } finally {
    limiter.release();
  }
}

/**
 * Test-only: discard the cached limiter so the next call re-reads the env knob.
 * Production code never needs this — the knob is read once per process.
 */
export function __resetNativeChatLimiterForTests(): void {
  nativeChatLimiter = null;
}

type ResponsesApiResponse = Record<string, unknown> & {
  error?: {
    message?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } & Record<string, unknown>;
};

/**
 * Models that are known to be reasoning-class and don't support temperature.
 * These are models that use chain-of-thought internally and reject
 */
const REASONING_MODEL_PATTERNS = [
  "o1",
  "o3",
  "o4",
  "deepseek-r1",
  "deepseek-reasoner",
  "claude-opus-4.7",
  "claude-opus-4-7",
  "gpt-5",
] as const;
type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

type GenerateTextParamsWithAttachments = GenerateTextParams & {
  attachments?: ChatAttachment[];
};

type GenerateTextParamsWithNativeOptions = GenerateTextParamsWithAttachments & {
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  responseSchema?: unknown;
  providerOptions?: Record<string, unknown>;
};

type NativeTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type NativeGenerateTextResult = {
  text: string;
  toolCalls: unknown[];
  finishReason?: string;
  usage?: NativeTokenUsage;
  providerMetadata?: unknown;
};

type NativeGenerateTextModelResult = NativeGenerateTextResult & string;

type NativeToolCall = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ChatCompletionsResponse = Record<string, unknown> & {
  error?: {
    message?: string;
  };
  choices?: Array<{
    text?: string;
    finish_reason?: string;
    message?: {
      content?: unknown;
      tool_calls?: unknown[];
    };
  }>;
  usage?: Record<string, unknown>;
};

/**
 * Eliza-Cloud-hosted `eliza-1` model ids that run a fork of llama-server (or
 * vLLM with the eliza1 parsers) capable of honoring the `x-eliza-span-samplers`
 * header. Other upstreams (OpenAI / Anthropic / generic OpenRouter) strip
 * unknown headers safely, but to keep the wire surface narrow we only attach
 * the per-span sampler plan when the resolved model is one we know honors it.
 *
 * The "we know" bound is conservative — extend the prefix list when a new
 * fork-built deployment lands. The fallback is "do not send the header" which
 * preserves today's behavior on every other provider.
 */
const SPAN_SAMPLER_HONORING_MODEL_PREFIXES = [
  "vast/eliza-1-",
  "elizaos/eliza-1-",
  "eliza-1-",
] as const;

function isSpanSamplerHonoringModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return SPAN_SAMPLER_HONORING_MODEL_PREFIXES.some((prefix) =>
    lower.startsWith(prefix),
  );
}

/**
 * Build the `x-eliza-span-samplers` HTTP header value from a {@link SpanSamplerPlan}.
 * Returns `undefined` when there is no plan or no overrides — narrow the wire
 * surface so non-eliza providers never see a stray fork-extension header.
 *
 * Wire schema (snake_case):
 *   { overrides: [{ span_index, temperature, top_k?, top_p? }, ...], strict?: boolean }
 */
function buildSpanSamplerHeader(
  plan: GenerateTextParams["spanSamplerPlan"],
): string | undefined {
  if (!plan || plan.overrides.length === 0) return undefined;
  const overrides = plan.overrides.map((o) => {
    const wire: Record<string, unknown> = {
      span_index: o.spanIndex,
      temperature: o.temperature,
    };
    if (typeof o.topK === "number") wire.top_k = o.topK;
    if (typeof o.topP === "number") wire.top_p = o.topP;
    return wire;
  });
  const body: Record<string, unknown> = { overrides };
  if (plan.strict === true) body.strict = true;
  return JSON.stringify(body);
}

/**
 * Extract the authoritative USD cost the metered cloud gateway charged for a
 * request, when it surfaces one. The gateway is the only honest source of USD
 * (it owns the model-pricing table + platform markup); we prefer it over any
 * client-side token estimate. Checks the response body `usage.cost_usd` first,
 * then the `X-Eliza-Cost-Usd` response header. Returns undefined when neither
 * is present so consumers fall back to a token-based estimate.
 */
function extractCostUsd(
  usage: unknown,
  response?: { headers?: { get?: (name: string) => string | null } }
): number | undefined {
  const fromBody = firstNumber(
    asRecord(usage).cost_usd,
    asRecord(usage).costUsd,
    asRecord(usage).cost
  );
  if (typeof fromBody === "number" && Number.isFinite(fromBody)) {
    return fromBody;
  }
  const header = response?.headers?.get?.("X-Eliza-Cost-Usd");
  if (header) {
    const parsed = Number(header);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isReasoningModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return REASONING_MODEL_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Strips provider prefixes and variant suffixes so Cerebras-served models can
 * be recognized by bare id (one Cloud key serves many providers, and callers
 * pass `cerebras:...` / `openai/...` / `:suffix` forms interchangeably).
 */
function normalizeCerebrasModelId(modelName: string): string {
  return modelName
    .trim()
    .toLowerCase()
    .replace(/^cerebras[:/]/, "")
    .replace(/^openai\//, "")
    .replace(/:(?!free$).+$/, "");
}

function resolveCerebrasThinkingOffReasoningEffort(
  modelName: string
): "low" | "none" | undefined {
  const id = normalizeCerebrasModelId(modelName);
  if (id === "gpt-oss-120b") {
    return "low";
  }
  if (id === DEFAULT_CEREBRAS_TEXT_MODEL || id === "zai-glm-4.7") {
    return "none";
  }
  return undefined;
}

const VALID_USER_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
]);

/**
 * User-pinned reasoning effort (`ELIZAOS_CLOUD_REASONING_EFFORT`) — the seam
 * `/model … effort=…` and the settings panel persist for cloud-routed chat.
 * Scoped to the Cerebras-served reasoning trio (recognized via the same
 * normalizer the thinking-off suppression uses): the cloud proxies many
 * providers, and an unexpected `reasoning_effort` 400s on models that don't
 * take the knob. The thinking-off suppression in buildNativeRequestBody runs
 * after this and overwrites it, so Stage-1 formatting calls stay cheap
 * regardless of the pin.
 */
function resolveUserReasoningEffort(
  runtime: IAgentRuntime | undefined,
  modelName: string
): string | undefined {
  const raw = runtime?.getSetting("ELIZAOS_CLOUD_REASONING_EFFORT");
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const effort = raw.trim().toLowerCase();
  if (!VALID_USER_REASONING_EFFORTS.has(effort)) {
    logger.warn(
      `[ELIZAOS_CLOUD] ELIZAOS_CLOUD_REASONING_EFFORT=${raw} is not a valid reasoning effort; ignoring. Expected one of: ${[...VALID_USER_REASONING_EFFORTS].join(", ")}.`
    );
    return undefined;
  }
  return resolveCerebrasThinkingOffReasoningEffort(modelName) !== undefined
    ? effort
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(value[key]);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Bounded retry for the cold-gateway "warming" 503 (first turn after idle).
 *
 * A cold Cloudflare Worker answers with 503 and a machine-readable warming
 * code (`*_cache_warming`, or the generative ApiError retryable envelope)
 * while it hydrates auth/billing caches under waitUntil — recovery is ~3s.
 * That 503 is a retry-shortly signal, NOT a dead provider, but the runtime's
 * useModel failover ladder classifies any thrown 503 as fallback-class and
 * advances instantly, so one cold gateway spent the whole
 * RESPONSE_HANDLER→TEXT_NANO→TEXT_SMALL→TEXT_LARGE ladder in ~500ms and the
 * turn died. Retrying the SAME request here (inside the handler) keeps the
 * ladder intact for real provider failures. The gate is structural — HTTP
 * status + typed body code/flag — never message prose, so a genuinely dead
 * provider (any other 503 body, or any non-503) still throws immediately.
 * The schedule is bounded and sums past the measured ~3s recovery; a
 * Retry-After header or `details.retryAfterSeconds` stretches an individual
 * wait up to a hard cap but never adds attempts.
 */
const WARMING_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 1500];
const WARMING_RETRY_MAX_WAIT_MS = 2_000;

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // error-policy:J3 a non-JSON error body is an explicit "not warming"
    // predicate result; the caller surfaces the original HTTP failure.
    return undefined;
  }
}

/**
 * True only for the gateway's explicit cache-warming 503 shape:
 * `{ error: { code: "*_cache_warming" } }` (chat/completions, embeddings) or
 * the generative ApiError envelope `{ code: "service_unavailable",
 * details: { retryable: true } }`. Everything else — including provider-5xx
 * mapped 503s (`api_error`, upstream codes) and `ai_not_configured` — is a
 * real failure and must keep failing over promptly.
 */
export function isWarmingUnavailableResponse(status: number, bodyText: string): boolean {
  if (status !== 503) return false;
  const body = parseJsonRecord(bodyText);
  if (!body) return false;
  const errorCode = asRecord(body.error).code;
  if (typeof errorCode === "string" && errorCode.endsWith("_cache_warming")) {
    return true;
  }
  return body.code === "service_unavailable" && asRecord(body.details).retryable === true;
}

interface WarmingRetryState {
  attempt: number;
}

/**
 * Next backoff wait for a warming 503, or undefined when the response is not
 * a warming 503 or the bounded budget is spent. Respects `Retry-After`
 * (seconds) and the envelope's `retryAfterSeconds` when present, clamped to
 * [scheduled delay, WARMING_RETRY_MAX_WAIT_MS] so the server can stretch a
 * wait but never shrink the schedule below recovery or grow it unbounded.
 */
export function nextWarmingRetryDelayMs(
  state: WarmingRetryState,
  response: Response,
  bodyText: string
): number | undefined {
  if (!isWarmingUnavailableResponse(response.status, bodyText)) return undefined;
  if (state.attempt >= WARMING_RETRY_DELAYS_MS.length) return undefined;
  const scheduled = WARMING_RETRY_DELAYS_MS[state.attempt];
  state.attempt += 1;
  const retryAfterSeconds = firstNumber(
    response.headers.get("retry-after") ?? undefined,
    asRecord(parseJsonRecord(bodyText)?.details).retryAfterSeconds
  );
  if (retryAfterSeconds === undefined || retryAfterSeconds < 0) return scheduled;
  return Math.min(
    Math.max(Math.round(retryAfterSeconds * 1000), scheduled),
    WARMING_RETRY_MAX_WAIT_MS
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a buffered cloud text round-trip under the shared concurrency cap,
 * retrying in place while the gateway reports the structural warming 503.
 * The permit is held only across each network attempt — body reads and
 * backoff sleeps run unguarded. Returns the final response with its body
 * already read so callers never double-consume it; non-warming failures and
 * an exhausted budget return immediately for the caller's normal error path.
 */
export async function requestNativeWithWarmingRetry(
  doRequest: () => Promise<Response>,
  label: string
): Promise<{ response: Response; bodyText: string }> {
  const state: WarmingRetryState = { attempt: 0 };
  for (;;) {
    const response = await withNativeChatLimit(doRequest, label);
    const bodyText = await response.text();
    // Recorded before the status check so the give-up 503 keeps its gateway
    // decomposition too — a turn that burned the whole warming ladder is
    // exactly the turn whose pre-forward attribution matters.
    recordGatewayResponseTelemetry(response, label);
    if (response.status !== 503) return { response, bodyText };
    const delayMs = nextWarmingRetryDelayMs(state, response, bodyText);
    if (delayMs === undefined) return { response, bodyText };
    logger.warn(
      `[ELIZAOS_CLOUD] cloud gateway is warming (503) on ${label}; retrying in ${delayMs}ms (attempt ${state.attempt}/${WARMING_RETRY_DELAYS_MS.length})`
    );
    await sleepMs(delayMs);
  }
}

const NATIVE_TOOL_CALL_ERROR_CODE = "ELIZA_CLOUD_TOOL_CALL_INVALID";
const NATIVE_STREAM_ERROR_CODE = "ELIZA_CLOUD_STREAM_INVALID";

function invalidNativeToolCall(reason: string, cause?: unknown): ElizaError {
  return new ElizaError("elizaOS Cloud returned an invalid tool call", {
    code: NATIVE_TOOL_CALL_ERROR_CODE,
    context: { reason },
    cause,
    severity: "ephemeral",
  });
}

function invalidNativeStream(reason: string, cause?: unknown): ElizaError {
  return new ElizaError("elizaOS Cloud returned an invalid stream", {
    code: NATIVE_STREAM_ERROR_CODE,
    context: { reason },
    cause,
    severity: "ephemeral",
  });
}

function parseNativeToolCallInput(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw invalidNativeToolCall("tool-call arguments are empty");
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (cause) {
      // error-policy:J2 preserve the wire parse failure under a stable tool-call classification.
      throw invalidNativeToolCall(
        "tool-call arguments are not one complete JSON value",
        cause
      );
    }
  }
  if (!isRecord(parsed)) {
    throw invalidNativeToolCall("tool-call arguments must be a JSON object");
  }
  return parsed;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function hasNativeTransportOptions(params: GenerateTextParamsWithNativeOptions): boolean {
  return Boolean(
    params.messages ||
      params.tools ||
      params.toolChoice ||
      params.responseSchema ||
      params.providerOptions
  );
}

function shouldReturnNativeResult(params: GenerateTextParamsWithNativeOptions): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

function toolCallIds(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const ids: string[] = [];
  for (const call of toolCalls) {
    const id = firstString(asRecord(call).id);
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

// The native `/chat/completions` gateway strictly enforces OpenAI tool-call
// linkage: a `role:"tool"` message is only valid when a directly-preceding
// assistant message declared a matching id in its `tool_calls`, and an
// assistant `tool_calls` entry is only valid when a later tool message answers
// it. Runtime-rendered history routinely violates both — a prior turn's tool
// result surfaces as a bare `role:"tool"` message with no `tool_call_id` and no
// assistant `tool_calls` before it — and the gateway 400s the WHOLE request on
// that (`invalid_request_error`), breaking every tool-using turn. Reconstructing
// the original `tool_calls` isn't possible from rendered history, so make the
// array spec-valid instead: downgrade every unpaired tool message to a plain
// `role:"user"` message (verified 200 against the gateway) with a `[tool result]`
// marker so its content survives, and strip `tool_calls` from any assistant
// message whose calls go unanswered (which would otherwise 500 "Tool result is
// missing"). Well-formed assistant→tool pairs pass through untouched.
function sanitizeNativeMessages(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const result = messages.map((message) => ({ ...message }));
  let openAssistant: Record<string, unknown> | null = null;
  let matchedToolMessages: Array<Record<string, unknown>> = [];
  let pending = new Set<string>();
  const downgradeToolMessage = (message: Record<string, unknown>): void => {
    delete message.tool_call_id;
    message.role = "user";
    message.content = `[tool result] ${stringifyMessageContent(message.content)}`;
  };
  const finalizeOpenAssistant = (): void => {
    if (openAssistant && pending.size > 0) {
      delete openAssistant.tool_calls;
      if (openAssistant.content == null) {
        openAssistant.content = "";
      }
      for (const toolMessage of matchedToolMessages) {
        downgradeToolMessage(toolMessage);
      }
    }
    openAssistant = null;
    matchedToolMessages = [];
    pending = new Set();
  };
  for (const message of result) {
    if (message.role === "tool") {
      const id = firstString(message.tool_call_id);
      if (id && pending.has(id)) {
        pending.delete(id);
        matchedToolMessages.push(message);
      } else {
        if (openAssistant && pending.size > 0) {
          finalizeOpenAssistant();
        }
        downgradeToolMessage(message);
      }
      continue;
    }
    finalizeOpenAssistant();
    if (message.role === "assistant") {
      const ids = toolCallIds(message.tool_calls);
      if (ids.length > 0) {
        openAssistant = message;
        pending = new Set(ids);
      }
    }
  }
  finalizeOpenAssistant();
  return result;
}

function buildNativeMessages(
  params: GenerateTextParamsWithNativeOptions,
  promptText: string,
  systemPrompt?: string
): Array<Record<string, unknown>> {
  if (Array.isArray(params.messages) && params.messages.length > 0) {
    const messages = params.messages.map((message) =>
      isRecord(message)
        ? { ...message }
        : { role: "user", content: stringifyMessageContent(message) }
    );
    const first = asRecord(messages[0]);
    const withSystem =
      systemPrompt && first.role !== "system"
        ? [{ role: "system", content: systemPrompt }, ...messages]
        : messages;
    return sanitizeNativeMessages(withSystem);
  }

  const messages: Array<Record<string, unknown>> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: promptText });
  return messages;
}

function unwrapJsonSchema(value: unknown): unknown {
  const record = asRecord(value);
  return record.schema ?? record.jsonSchema ?? value;
}

// Normalize a single tool entry into the OpenAI `{ type, function }` wire
// shape. Accepts BOTH the already-nested form (`{ type: "function", function:
// { name, parameters } }`) and core's FLAT `ToolDefinition` envelope
// (`{ name, type: "function", parameters }`, e.g. createHandleResponseTool /
// the action planner). Returning the flat form verbatim made the cloud gateway
// read `tool.function.name` on an undefined `function` → "Cannot read
// properties of undefined (reading 'name')". Returns undefined for entries with
// no resolvable name so they are dropped rather than crashing downstream.
function normalizeNativeToolEntry(
  rawTool: unknown,
  fallbackName?: string
): Record<string, unknown> | undefined {
  const tool = asRecord(rawTool);
  const nested = asRecord(tool.function);
  const name = firstString(nested.name, tool.name, fallbackName);
  if (!name) {
    return undefined;
  }
  const description = firstString(nested.description, tool.description);
  const inputSchema = unwrapJsonSchema(
    nested.parameters ??
      tool.inputSchema ??
      tool.parameters ??
      tool.schema ?? { type: "object" }
  );
  return {
    type: "function",
    function: {
      name,
      ...(description ? { description } : {}),
      parameters: inputSchema,
    },
  };
}

export function normalizeNativeTools(tools: unknown): unknown[] | undefined {
  if (!tools) {
    return undefined;
  }

  if (Array.isArray(tools)) {
    const normalized = tools
      .map((tool) => normalizeNativeToolEntry(tool))
      .filter((tool): tool is Record<string, unknown> => tool !== undefined);
    return normalized.length > 0 ? normalized : undefined;
  }

  const toolSet = asRecord(tools);
  const normalized: unknown[] = [];
  for (const [name, rawTool] of Object.entries(toolSet)) {
    const entry = normalizeNativeToolEntry(rawTool, name);
    if (entry) {
      normalized.push(entry);
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeNativeToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (
    typeof toolChoice === "string" &&
    (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required")
  ) {
    return toolChoice;
  }

  const choice = asRecord(toolChoice);
  if (choice.type === "function") {
    const functionChoice = recordAt(choice, "function");
    const toolName = firstString(functionChoice.name, choice.name, choice.toolName);
    return toolName
      ? {
          type: "function",
          function: {
            ...functionChoice,
            name: toolName,
          },
        }
      : undefined;
  }
  if (choice.type === "tool") {
    const toolName = firstString(choice.toolName, choice.name);
    return toolName ? { type: "function", function: { name: toolName } } : toolChoice;
  }

  const functionChoice = asRecord(choice.function);
  const toolName = firstString(choice.toolName, choice.name, functionChoice.name);
  return toolName ? { type: "function", function: { name: toolName } } : toolChoice;
}

function buildNativeResponseFormat(responseSchema: unknown, _modelName: string): unknown {
  if (!responseSchema) {
    return undefined;
  }

  // An explicit caller-supplied response format still wins.
  const schemaRecord = asRecord(responseSchema);
  if (schemaRecord.responseFormat) {
    return schemaRecord.responseFormat;
  }

  // The Cloud's native `/chat/completions` gateway 400s on `response_format`
  // for its served models — BOTH `json_schema` AND `json_object`, verified
  // live against zai-glm-4.7 AND gemma-4-31b (each: with either format → 400,
  // without → 200). The structured schema is already embedded in the prompt
  // body and the caller repairs/validates the returned JSON, so omit
  // `response_format` entirely; otherwise every structured-output call (the
  // trajectory evaluator, the planner) fails with `Bad Request` and breaks
  // every tool-using turn (web search, price lookups, sub-agent spawns).
  return undefined;
}

function resolvePromptCacheKey(providerOptions: Record<string, unknown>): string | undefined {
  const eliza = recordAt(providerOptions, "eliza");
  const openrouter = recordAt(providerOptions, "openrouter");
  const openai = recordAt(providerOptions, "openai");
  const cerebras = recordAt(providerOptions, "cerebras");

  return firstString(
    providerOptions.promptCacheKey,
    providerOptions.prompt_cache_key,
    eliza.promptCacheKey,
    eliza.prompt_cache_key,
    openrouter.promptCacheKey,
    openrouter.prompt_cache_key,
    openai.promptCacheKey,
    openai.prompt_cache_key,
    cerebras.promptCacheKey,
    cerebras.prompt_cache_key
  );
}

function resolveNativeProviderOptions(
  params: GenerateTextParamsWithNativeOptions
): Record<string, unknown> | undefined {
  const raw = asRecord(params.providerOptions);
  if (Object.keys(raw).length === 0) {
    return undefined;
  }

  const { agentName: _agentName, eliza: _eliza, ...rest } = raw;
  const providerOptions: Record<string, unknown> = { ...rest };
  const promptCacheKey = resolvePromptCacheKey(raw);

  if (promptCacheKey) {
    providerOptions.openai = {
      ...recordAt(providerOptions, "openai"),
      promptCacheKey,
      prompt_cache_key: promptCacheKey,
    };
    providerOptions.openrouter = {
      ...recordAt(providerOptions, "openrouter"),
      promptCacheKey,
      prompt_cache_key: promptCacheKey,
    };
    providerOptions.cerebras = {
      ...recordAt(providerOptions, "cerebras"),
      prompt_cache_key: promptCacheKey,
    };
  }

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

function applyOpenRouterPassthroughFields(
  requestBody: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined
): void {
  if (!providerOptions) {
    return;
  }

  const openrouter = recordAt(providerOptions, "openrouter");
  if (Object.keys(openrouter).length > 0) {
    const provider = openrouter.provider;
    if (provider !== undefined) {
      requestBody.provider = provider;
    }
    for (const key of ["models", "route", "transforms", "reasoning"] as const) {
      if (openrouter[key] !== undefined) {
        requestBody[key] = openrouter[key];
      }
    }
  }

  const gateway = providerOptions.gateway;
  if (gateway !== undefined) {
    requestBody.gateway = gateway;
  }
}

function buildNativeRequestBody(
  params: GenerateTextParamsWithNativeOptions,
  modelName: string,
  promptText: string,
  systemPrompt?: string,
  runtime?: IAgentRuntime
): Record<string, unknown> {
  const providerOptions = resolveNativeProviderOptions(params);
  const promptCacheKey = providerOptions ? resolvePromptCacheKey(providerOptions) : undefined;
  const tools = normalizeNativeTools(params.tools);
  const toolChoice = normalizeNativeToolChoice(params.toolChoice);
  const responseFormat = buildNativeResponseFormat(params.responseSchema, modelName);
  const requestBody: Record<string, unknown> = {
    model: modelName,
    messages: buildNativeMessages(params, promptText, systemPrompt),
  };
  // Omit the cap entirely when the caller opted out (direct-channel Stage-1):
  // a hardcoded max_tokens 400s on a model whose real limit differs. Every other
  // caller keeps the 8192 default so it stays bounded.
  if (!params.omitMaxTokens) {
    requestBody.max_tokens = params.maxTokens ?? 8192;
  }

  if (!isReasoningModel(modelName) && typeof params.temperature === "number") {
    requestBody.temperature = params.temperature;
  }
  const userReasoningEffort = resolveUserReasoningEffort(runtime, modelName);
  if (userReasoningEffort) {
    requestBody.reasoning_effort = userReasoningEffort;
  }
  // The runtime signals "don't reason" via providerOptions.eliza.thinking="off"
  // (e.g. the Stage-1 RESPONSE_HANDLER formatting call), but
  // resolveNativeProviderOptions drops the eliza block, so it never reaches the
  // wire automatically. Map that intent onto each Cerebras model's supported
  // `reasoning_effort` suppression value.
  if (recordAt(asRecord(params.providerOptions), "eliza").thinking === "off") {
    const reasoningEffort = resolveCerebrasThinkingOffReasoningEffort(modelName);
    if (reasoningEffort) {
      requestBody.reasoning_effort = reasoningEffort;
    }
  }
  if (tools) {
    requestBody.tools = tools;
  }
  if (toolChoice) {
    requestBody.tool_choice = toolChoice;
  }
  if (responseFormat) {
    requestBody.response_format = responseFormat;
  }
  if (providerOptions) {
    requestBody.providerOptions = providerOptions;
    requestBody.provider_options = providerOptions;
  }
  if (promptCacheKey) {
    requestBody.promptCacheKey = promptCacheKey;
    requestBody.prompt_cache_key = promptCacheKey;
  }

  applyOpenRouterPassthroughFields(requestBody, providerOptions);
  return requestBody;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return firstString(record.text, record.output_text, record.content) ?? "";
    })
    .join("");
}

function extractChatCompletionText(data: ChatCompletionsResponse): string {
  const firstChoice = data.choices?.[0];
  if (!firstChoice) {
    return "";
  }
  return firstString(firstChoice.text, extractTextFromContent(firstChoice.message?.content)) ?? "";
}

function extractNativeToolCalls(data: ChatCompletionsResponse): NativeToolCall[] {
  const rawCalls = data.choices?.[0]?.message?.tool_calls;
  if (rawCalls === undefined) {
    return [];
  }
  if (!Array.isArray(rawCalls)) {
    throw invalidNativeToolCall("tool_calls must be an array");
  }

  const ids = new Set<string>();
  return rawCalls.map((rawCall, index) => {
    if (!isRecord(rawCall)) {
      throw invalidNativeToolCall(`tool_calls[${index}] must be an object`);
    }
    const call = rawCall;
    if (call.function !== undefined && !isRecord(call.function)) {
      throw invalidNativeToolCall(`tool_calls[${index}].function must be an object`);
    }
    const fn = asRecord(call.function);
    const toolCallId = firstString(call.id, call.toolCallId);
    if (!toolCallId) {
      throw invalidNativeToolCall(`tool_calls[${index}] is missing an id`);
    }
    if (ids.has(toolCallId)) {
      throw invalidNativeToolCall(`tool-call id ${toolCallId} is duplicated`);
    }
    ids.add(toolCallId);

    const toolName = firstString(call.name, call.toolName, fn.name);
    if (!toolName) {
      throw invalidNativeToolCall(`tool_calls[${index}] is missing a function name`);
    }

    let input: unknown;
    if (Object.hasOwn(call, "input")) {
      input = call.input;
    } else if (Object.hasOwn(call, "arguments")) {
      input = call.arguments;
    } else if (Object.hasOwn(fn, "arguments")) {
      input = fn.arguments;
    } else {
      throw invalidNativeToolCall(`tool_calls[${index}] is missing function arguments`);
    }

    return {
      type: "tool-call",
      toolCallId,
      toolName,
      input: parseNativeToolCallInput(input),
    };
  });
}

function convertNativeUsage(usage: unknown): NativeTokenUsage | undefined {
  const root = asRecord(usage);
  if (Object.keys(root).length === 0) {
    return undefined;
  }

  const inputTokenDetails = recordAt(root, "inputTokenDetails");
  const promptTokenDetails = recordAt(root, "prompt_tokens_details");
  const inputTokenDetailsSnake = recordAt(root, "input_tokens_details");
  const promptTokens =
    firstNumber(root.inputTokens, root.input_tokens, root.promptTokens, root.prompt_tokens) ?? 0;
  const completionTokens =
    firstNumber(
      root.outputTokens,
      root.output_tokens,
      root.completionTokens,
      root.completion_tokens
    ) ?? 0;
  const cacheReadInputTokens = firstNumber(
    root.cacheReadInputTokens,
    root.cache_read_input_tokens,
    root.cachedInputTokens,
    root.cached_input_tokens,
    root.cachedTokens,
    root.cached_tokens,
    inputTokenDetails.cacheReadTokens,
    inputTokenDetails.cachedInputTokens,
    inputTokenDetails.cachedTokens,
    promptTokenDetails.cached_tokens,
    inputTokenDetailsSnake.cache_read_input_tokens,
    inputTokenDetailsSnake.cached_tokens
  );
  const cacheCreationInputTokens = firstNumber(
    root.cacheCreationInputTokens,
    root.cache_creation_input_tokens,
    root.cacheWriteInputTokens,
    root.cache_write_input_tokens,
    inputTokenDetails.cacheCreationInputTokens,
    inputTokenDetails.cacheCreationTokens,
    inputTokenDetails.cacheWriteTokens,
    inputTokenDetailsSnake.cache_creation_input_tokens
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens:
      firstNumber(root.totalTokens, root.total_tokens) ?? promptTokens + completionTokens,
    cachedPromptTokens: cacheReadInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}

type TextModelType =
  | typeof TEXT_NANO_MODEL_TYPE
  | typeof TEXT_MEDIUM_MODEL_TYPE
  | typeof TEXT_SMALL_MODEL_TYPE
  | typeof TEXT_LARGE_MODEL_TYPE
  | typeof TEXT_MEGA_MODEL_TYPE
  | typeof RESPONSE_HANDLER_MODEL_TYPE
  | typeof ACTION_PLANNER_MODEL_TYPE;

function getPurposeForModelType(modelType: TextModelType): string {
  switch (modelType) {
    case RESPONSE_HANDLER_MODEL_TYPE:
      return "should_respond";
    case ACTION_PLANNER_MODEL_TYPE:
      return "action_planner";
    default:
      return "response";
  }
}

function getModelNameForType(runtime: IAgentRuntime, modelType: TextModelType): string {
  switch (modelType) {
    case TEXT_NANO_MODEL_TYPE:
      return getNanoModel(runtime);
    case TEXT_MEDIUM_MODEL_TYPE:
      return getMediumModel(runtime);
    case TEXT_SMALL_MODEL_TYPE:
      return getSmallModel(runtime);
    case TEXT_LARGE_MODEL_TYPE:
      return getLargeModel(runtime);
    case TEXT_MEGA_MODEL_TYPE:
      return getMegaModel(runtime);
    case RESPONSE_HANDLER_MODEL_TYPE:
      return getResponseHandlerModel(runtime);
    case ACTION_PLANNER_MODEL_TYPE:
      return getActionPlannerModel(runtime);
    default:
      return getLargeModel(runtime);
  }
}

/**
 * Resolve the model name, rendered prompt, and effective system prompt for a
 * cloud text call.
 *
 * This used to also construct a Vercel AI-SDK `LanguageModel` (`openai.chat()`)
 * plus a full `generateParams` object — but the handlers below call the cloud
 * HTTP API directly (`requestRaw` → `/responses` / `/chat/completions`), so that
 * AI-SDK client + params object was built and immediately discarded on every
 * single text generation. Removed: it was pure per-call overhead and a
 * misleading code path when reasoning about which transport actually runs.
 */
function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
) {
  const prompt = params.prompt ?? "";
  const modelName = getModelNameForType(runtime, modelType);
  const systemPrompt = resolveEffectiveSystemPrompt({
    params,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
  const promptText =
    renderChatMessagesForPrompt(params.messages, {
      omitDuplicateSystem: systemPrompt,
    }) ?? prompt;

  return { modelName, modelType, prompt: promptText, systemPrompt };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const { modelName, prompt, systemPrompt } = buildGenerateParams(runtime, modelType, params);
  const paramsWithNative = params as GenerateTextParamsWithNativeOptions;

  logger.debug(`[ELIZAOS_CLOUD] Generating text with ${modelType} model: ${modelName}`);

  // Stream the user-visible reply token-by-token. Gated to the structured
  // reply path (`streamStructured`, set only by the RESPONSE_HANDLER stage-1
  // call): that call carries a responseSkeleton, so the runtime's field
  // extractor surfaces `replyText` incrementally to the UI. Planner/other
  // native calls (no responseSkeleton) stay buffered — streaming their raw
  // envelope would leak internals to the UI stream. The bare `/responses`
  // route stays buffered too (different SSE schema, not on the reply path).
  const paramsStreaming = params as {
    stream?: boolean;
    streamStructured?: boolean;
  };
  const wantsStream =
    Boolean(paramsStreaming.stream) &&
    paramsStreaming.streamStructured === true &&
    resolveStreamingEnabled();

  logger.log(`[ELIZAOS_CLOUD] Using ${modelType} model: ${modelName}`);

  if (hasNativeTransportOptions(paramsWithNative)) {
    if (wantsStream) {
      return streamNativeChatCompletion(runtime, modelType, paramsWithNative, {
        modelName,
        prompt,
        systemPrompt,
      });
    }
    const nativeResult = await generateNativeChatCompletion(runtime, modelType, paramsWithNative, {
      modelName,
      prompt,
      systemPrompt,
    });
    return shouldReturnNativeResult(paramsWithNative)
      ? (nativeResult as NativeGenerateTextModelResult)
      : nativeResult.text;
  }

  const reasoning = isReasoningModel(modelName);
  const input: Array<{
    role: "system" | "user";
    content: Array<{ type: "input_text"; text: string }>;
  }> = [];
  if (systemPrompt) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }],
    });
  }
  input.push({
    role: "user",
    content: [{ type: "input_text", text: prompt }],
  });

  const requestBody: Record<string, unknown> = {
    model: modelName,
    input,
  };
  if (!params.omitMaxTokens) {
    requestBody.max_output_tokens = params.maxTokens ?? 8192;
  }
  if (!reasoning && typeof params.temperature === "number") {
    requestBody.temperature = params.temperature;
  }

  const responsesHeaders: Record<string, string> = withInferenceTraceHeader({
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
  });
  if (isSpanSamplerHonoringModel(modelName)) {
    const samplerHeader = buildSpanSamplerHeader(params.spanSamplerPlan);
    if (samplerHeader) {
      responsesHeaders["x-eliza-span-samplers"] = samplerHeader;
    }
  }
  // Same shared cerebras key as the /chat/completions route, so gate this
  // bare-prompt round-trip through the SAME limiter (parsing stays unguarded).
  // A cold gateway's warming 503 is retried in place instead of throwing into
  // the runtime failover ladder (see requestNativeWithWarmingRetry).
  const { response, bodyText: responseText } = await requestNativeWithWarmingRetry(
    () =>
      createCloudApiClient(runtime).requestRaw("POST", "/responses", {
        headers: responsesHeaders,
        json: requestBody,
        timeoutMs: resolveTextTimeoutMs(),
      }),
    "responses"
  );
  let data: ResponsesApiResponse = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText) as ResponsesApiResponse;
    } catch (parseErr) {
      logger.error(
        `[ELIZAOS_CLOUD] Failed to parse responses JSON: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`
      );
    }
  }

  if (!response.ok) {
    const errorBody = typeof data === "object" && data ? data.error : undefined;
    const errorMessage =
      typeof errorBody?.message === "string" && errorBody.message.trim()
        ? errorBody.message.trim()
        : `elizaOS Cloud error ${response.status}`;
    const requestError = new Error(errorMessage) as Error & {
      status?: number;
      error?: unknown;
    };
    requestError.status = response.status;
    if (errorBody) {
      requestError.error = errorBody;
    }
    throw requestError;
  }

  if (data.usage) {
    emitModelUsageEvent(
      runtime,
      modelType,
      prompt,
      {
        inputTokens: data.usage.input_tokens ?? 0,
        outputTokens: data.usage.output_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      },
      {
        modelName: getModelNameForType(runtime, modelType),
        ...(() => {
          const costUsd = extractCostUsd(data.usage, response);
          return typeof costUsd === "number" ? { costUsd } : {};
        })(),
      }
    );
  }

  const text = extractResponsesOutputText(data);
  if (!text.trim()) {
    throw new Error("elizaOS Cloud returned no text response");
  }

  return text;
}

// Exported for unit tests (the concurrency limiter wrapper). Not part of the
// plugin's public model-handler surface.
export async function generateNativeChatCompletion(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParamsWithNativeOptions,
  context: {
    modelName: string;
    prompt: string;
    systemPrompt?: string;
  }
): Promise<NativeGenerateTextResult> {
  const requestBody = buildNativeRequestBody(
    params,
    context.modelName,
    context.prompt,
    context.systemPrompt,
    runtime
  );
  const headers: Record<string, string> = withInferenceTraceHeader({
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
  });
  // Per-span sampler overrides only ride along when the resolved model is a
  // fork-built eliza-1 deployment that knows how to honor the header. Other
  // upstreams (OpenAI / Anthropic / generic OpenRouter) strip unknown headers
  // safely, but we keep the wire surface narrow until the cloud honor path
  // lands in Wave 3.
  if (isSpanSamplerHonoringModel(context.modelName)) {
    const samplerHeader = buildSpanSamplerHeader(params.spanSamplerPlan);
    if (samplerHeader) {
      headers["x-eliza-span-samplers"] = samplerHeader;
    }
  }
  // Serialize the per-turn batcher/evaluator burst through the SAME shared
  // semaphore the /responses route uses, so N simultaneous native cloud text
  // calls don't overrun the one shared cerebras key's concurrent limit (-> 429
  // -> retries -> 30-63s). The permit is held only across the network
  // round-trip; the text()/JSON parse below runs unguarded. A cold gateway's
  // warming 503 is retried in place instead of throwing into the runtime
  // failover ladder (see requestNativeWithWarmingRetry).
  const { response, bodyText: responseText } = await requestNativeWithWarmingRetry(
    () =>
      createCloudApiClient(runtime).requestRaw("POST", "/chat/completions", {
        headers,
        json: requestBody,
        timeoutMs: resolveTextTimeoutMs(),
      }),
    "chat/completions"
  );
  let data: ChatCompletionsResponse = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText) as ChatCompletionsResponse;
    } catch (parseErr) {
      logger.error(
        `[ELIZAOS_CLOUD] Failed to parse chat completions JSON: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`
      );
    }
  }

  if (!response.ok) {
    const errorBody = typeof data === "object" && data ? data.error : undefined;
    const errorMessage =
      typeof errorBody?.message === "string" && errorBody.message.trim()
        ? errorBody.message.trim()
        : `elizaOS Cloud error ${response.status}`;
    const requestError = new Error(errorMessage) as Error & {
      status?: number;
      error?: unknown;
    };
    requestError.status = response.status;
    if (errorBody) {
      requestError.error = errorBody;
    }
    throw requestError;
  }

  const usage = convertNativeUsage(data.usage);
  if (usage) {
    emitModelUsageEvent(runtime, modelType, context.prompt, usage, {
      modelName: context.modelName,
      ...(() => {
        const costUsd = extractCostUsd(data.usage, response);
        return typeof costUsd === "number" ? { costUsd } : {};
      })(),
    });
  }

  const text = extractChatCompletionText(data);
  const toolCalls = extractNativeToolCalls(data);
  if (!text.trim() && toolCalls.length === 0) {
    throw new Error("elizaOS Cloud returned no text or tool calls");
  }

  return {
    text,
    toolCalls,
    finishReason: data.choices?.[0]?.finish_reason,
    usage,
    providerMetadata: {
      modelName: context.modelName,
      usage: data.usage,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming native /chat/completions (token-by-token, OpenAI-compatible SSE)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // error-policy:J5 consumers observe the original promise; this branch only
  // prevents an unhandled rejection when textStream fails before side fields
  // are awaited.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function streamCancellationError(signal: AbortSignal | undefined): unknown {
  if (signal?.aborted && signal.reason !== undefined) {
    return signal.reason;
  }
  return new DOMException("Stream consumer cancelled", "AbortError");
}

/**
 * Parse an OpenAI-compatible SSE byte stream into the decoded JSON frame of
 * each `data:` line. Yields one object per frame and requires `data: [DONE]`
 * before transport EOF. Partial reads are buffered across chunk boundaries;
 * comments and blank separators remain valid SSE framing.
 */
export async function* parseOpenAiSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string): Record<string, unknown> | "DONE" | null => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (payload === "") {
      throw invalidNativeStream("encountered an empty data frame");
    }
    if (payload === "[DONE]") return "DONE";
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (cause) {
      // error-policy:J2 retain the provider payload parse error under the
      // stable stream classification consumed by callers and diagnostics.
      throw invalidNativeStream("encountered malformed data-frame JSON", cause);
    }
    if (!isRecord(parsed)) {
      throw invalidNativeStream("data-frame JSON must be an object");
    }
    return parsed;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const frame = handle(line);
        if (frame === "DONE") return;
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    const tail = handle(buffer);
    if (tail === "DONE") return;
    if (tail) yield tail;
    throw invalidNativeStream("transport ended before the [DONE] frame");
  } finally {
    // cancel() (not just releaseLock()) tears down the underlying connection,
    // so an EARLY consumer break (runtime abort / turn-supersede / a downstream
    // throw closes this generator via .return()) stops the upstream generation
    // instead of letting it run to its natural end and bill tokens nobody reads.
    // On natural completion the stream is already done, so this is a no-op; it
    // also releases the lock. Not threading the abort signal into the fetch on
    // purpose — cancel() gets the teardown without rejecting an in-flight read
    // with AbortError and changing the runtime's quiet-stop semantics.
    try {
      await reader.cancel();
    } catch {
      // error-policy:J6 the stream result already exposes the primary failure;
      // cancelling an already-closed reader is best-effort transport teardown.
    }
  }
}

interface StreamingToolCallAcc {
  id?: string;
  name?: string;
  args: string;
}

/**
 * True when `value` is one complete, self-contained JSON object (it parses and
 * is a plain object — not an array or scalar). Used to recognise Cerebras's
 * final aggregated tool-call frame, which re-sends the whole arguments object
 * rather than the next incremental fragment.
 *
 * Parsing (not brace-counting) is load-bearing: a proper prefix of a single
 * JSON object never itself parses as complete — the outer `{` stays open even
 * when an inner `}` arrives mid-stream (e.g. `{"a":{"b":1}`) — so this only
 * becomes true once the WHOLE object has arrived, which is exactly the resend
 * boundary. A brace counter would be fooled by that inner close.
 */
function parseCompleteJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // error-policy:J3 an incomplete fragment is an explicit false predicate;
    // finalization separately parses and surfaces invalid terminal arguments.
    return undefined;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(left[key], right[key])
    )
  );
}

/** Fold one SSE `delta.tool_calls[]` array into the per-index accumulator. */
export function accumulateToolCallDeltas(
  acc: Map<number, StreamingToolCallAcc>,
  deltas: unknown
): void {
  if (!Array.isArray(deltas)) {
    throw invalidNativeToolCall("delta.tool_calls must be an array");
  }
  for (const raw of deltas) {
    if (!isRecord(raw)) {
      throw invalidNativeToolCall("each streamed tool-call delta must be an object");
    }
    const d = raw;
    if (
      typeof d.index !== "number" ||
      !Number.isInteger(d.index) ||
      d.index < 0
    ) {
      throw invalidNativeToolCall(
        "each streamed tool-call delta requires a non-negative integer index"
      );
    }
    const index = d.index;
    const cur = acc.get(index) ?? { args: "" };
    const previousId = cur.id;
    const previousName = cur.name;
    let id: string | undefined;
    if (Object.hasOwn(d, "id")) {
      id = firstString(d.id);
      if (!id) {
        throw invalidNativeToolCall(`tool-call index ${index} has an invalid id`);
      }
      if (cur.id && cur.id !== id) {
        throw invalidNativeToolCall(
          `tool-call index ${index} changed id from ${cur.id} to ${id}`
        );
      }
      for (const [otherIndex, other] of acc) {
        if (otherIndex !== index && other.id === id) {
          throw invalidNativeToolCall(
            `tool-call id ${id} is mapped to indexes ${otherIndex} and ${index}`
          );
        }
      }
      cur.id = id;
    }

    if (d.function !== undefined && !isRecord(d.function)) {
      throw invalidNativeToolCall(`tool-call index ${index} has an invalid function`);
    }
    const fn = asRecord(d.function);
    let name: string | undefined;
    if (Object.hasOwn(fn, "name")) {
      name = firstString(fn.name);
      if (!name) {
        throw invalidNativeToolCall(`tool-call index ${index} has an invalid function name`);
      }
      if (cur.name && cur.name !== name) {
        throw invalidNativeToolCall(
          `tool-call index ${index} changed function name from ${cur.name} to ${name}`
        );
      }
      cur.name = name;
    }

    if (Object.hasOwn(fn, "arguments")) {
      if (typeof fn.arguments !== "string") {
        throw invalidNativeToolCall(
          `tool-call index ${index} has non-string argument fragments`
        );
      }
      // Cerebras streams the tool-call arguments incrementally, then emits a
      // FINAL aggregated frame that re-sends the COMPLETE arguments object
      // (re-carrying id + name). Blindly appending that re-send doubles the
      // JSON (`{…}{…}`). When both values are complete objects, the latter is a
      // consolidated copy rather than another fragment. The incremental bytes
      // may already be visible to the runtime, so an equivalent copy is
      // ignored and a divergent copy fails closed instead of rewriting history.
      const accumulatedObject = parseCompleteJsonObject(cur.args);
      const incomingObject = parseCompleteJsonObject(fn.arguments);
      if (
        id !== undefined &&
        name !== undefined &&
        previousId === id &&
        previousName === name &&
        accumulatedObject !== undefined &&
        incomingObject !== undefined
      ) {
        if (!jsonValuesEqual(accumulatedObject, incomingObject)) {
          throw invalidNativeToolCall(
            `tool-call index ${index} consolidated arguments conflict with streamed fragments`
          );
        }
      } else {
        cur.args += fn.arguments;
      }
    }
    if (
      !Object.hasOwn(d, "id") &&
      !Object.hasOwn(fn, "name") &&
      !Object.hasOwn(fn, "arguments")
    ) {
      throw invalidNativeToolCall(`tool-call index ${index} contains no identity or arguments`);
    }
    acc.set(index, cur);
  }
}

/**
 * Accumulated arguments of the lowest-index streamed tool call. The Stage-1
 * RESPONSE_HANDLER reply forces a single HANDLE_RESPONSE call (index 0), so this
 * is the reply envelope (`{"shouldRespond":...,"replyText":...}`) as it grows.
 * Returns "" before any call has appeared in the stream.
 */
export function lowestIndexToolCallArgs(acc: Map<number, StreamingToolCallAcc>): string {
  let lowest: number | undefined;
  for (const index of acc.keys()) {
    if (lowest === undefined || index < lowest) lowest = index;
  }
  return lowest === undefined ? "" : (acc.get(lowest)?.args ?? "");
}

/** Materialize accumulated tool-call deltas into the buffered-path shape. */
export function finalizeStreamedToolCalls(
  acc: Map<number, StreamingToolCallAcc>
): NativeToolCall[] {
  const out: NativeToolCall[] = [];
  const ids = new Set<string>();
  for (const [index, c] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!Number.isInteger(index) || index < 0) {
      throw invalidNativeToolCall("streamed tool-call index is invalid");
    }
    if (!c.id) {
      throw invalidNativeToolCall(`tool-call index ${index} is missing an id`);
    }
    if (ids.has(c.id)) {
      throw invalidNativeToolCall(`tool-call id ${c.id} is duplicated`);
    }
    ids.add(c.id);
    if (!c.name) {
      throw invalidNativeToolCall(`tool-call index ${index} is missing a function name`);
    }
    out.push({
      type: "tool-call",
      toolCallId: c.id,
      toolName: c.name,
      input: parseNativeToolCallInput(c.args),
    });
  }
  return out;
}

/**
 * Streaming variant of {@link generateNativeChatCompletion}: returns a
 * {@link TextStreamResult} whose `textStream` yields `delta.content` as it
 * arrives, so `useModel`'s for-await loop streams it to the UI from the first
 * token. Falls back to a single-chunk buffered result if the gateway answers
 * non-SSE (self-healing). The shared concurrency permit is held for the whole
 * stream lifetime (released in the generator's `finally`), not just until
 * headers arrive — otherwise the cap would under-count in-flight requests.
 */
export async function streamNativeChatCompletion(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParamsWithNativeOptions,
  context: { modelName: string; prompt: string; systemPrompt?: string }
): Promise<TextStreamResult> {
  const requestBody = buildNativeRequestBody(
    params,
    context.modelName,
    context.prompt,
    context.systemPrompt,
    runtime
  );
  requestBody.stream = true;
  // OpenAI-compatible: ask the server to include a final usage-only frame so we
  // can meter the streamed call accurately.
  requestBody.stream_options = { include_usage: true };

  const headers: Record<string, string> = withInferenceTraceHeader({
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
  });
  if (isSpanSamplerHonoringModel(context.modelName)) {
    const samplerHeader = buildSpanSamplerHeader(params.spanSamplerPlan);
    if (samplerHeader) {
      headers["x-eliza-span-samplers"] = samplerHeader;
    }
  }

  const abortSignal = (params as { signal?: AbortSignal }).signal;
  const signal = buildStreamAbortSignal(abortSignal, resolveTextTimeoutMs());

  const limiter = getNativeChatLimiter();
  let permitReleased = true;
  const releasePermit = (): void => {
    if (!permitReleased) {
      permitReleased = true;
      limiter.release();
    }
  };

  // Per-attempt permit: acquired before each round-trip, released across
  // warming-retry sleeps so a cold gateway never starves concurrent calls.
  // A warming 503's body is consumed for classification, so its terminal
  // throw happens here; every other non-ok status leaves the body unread for
  // the error path below.
  const warmingRetryState: WarmingRetryState = { attempt: 0 };
  let response: Response;
  for (;;) {
    const waitStartedAt = Date.now();
    await limiter.acquire();
    permitReleased = false;
    recordInferenceSpan("cloud.semaphore-wait", Date.now() - waitStartedAt, {
      route: "chat/completions:stream",
    });
    try {
      response = await createCloudApiClient(runtime).requestRaw("POST", "/chat/completions", {
        headers,
        json: requestBody,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      releasePermit();
      throw err;
    }
    if (response.status !== 503) break;
    const warmingBodyText = await response.text();
    releasePermit();
    const delayMs = nextWarmingRetryDelayMs(warmingRetryState, response, warmingBodyText);
    if (delayMs === undefined || signal?.aborted) {
      const errorBody = asRecord(parseJsonRecord(warmingBodyText)?.error);
      const message =
        firstString(errorBody.message) ?? `elizaOS Cloud error ${response.status}`;
      const requestError = new Error(message) as Error & {
        status?: number;
        error?: unknown;
      };
      requestError.status = response.status;
      if (Object.keys(errorBody).length > 0) requestError.error = errorBody;
      throw requestError;
    }
    logger.warn(
      `[ELIZAOS_CLOUD] cloud gateway is warming (503) on chat/completions:stream; retrying in ${delayMs}ms (attempt ${warmingRetryState.attempt}/${WARMING_RETRY_DELAYS_MS.length})`
    );
    await sleepMs(delayMs);
  }
  // Recorded before the ok-check so a failed forward still keeps its gateway
  // decomposition on the turn — errors are where attribution matters most.
  recordGatewayResponseTelemetry(response, "chat/completions:stream");

  if (!response.ok) {
    let errorBody: { message?: string } | undefined;
    try {
      const errText = await response.text();
      if (errText) {
        errorBody = (JSON.parse(errText) as ChatCompletionsResponse).error;
      }
    } catch {
      // Non-JSON error body — fall through to the status-coded message.
    }
    releasePermit();
    const message =
      typeof errorBody?.message === "string" && errorBody.message.trim()
        ? errorBody.message.trim()
        : `elizaOS Cloud error ${response.status}`;
    const requestError = new Error(message) as Error & {
      status?: number;
      error?: unknown;
    };
    requestError.status = response.status;
    if (errorBody) requestError.error = errorBody;
    throw requestError;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isSse = contentType.includes("text/event-stream") && response.body !== null;

  // Self-healing fallback: gateway answered with a buffered JSON body despite
  // the stream request. Yield it as a single chunk so the streaming contract
  // (and the structured-field extractor downstream) still works.
  if (!isSse) {
    const bufferedText = await response.text();
    releasePermit();
    let data: ChatCompletionsResponse = {};
    if (bufferedText) {
      try {
        data = JSON.parse(bufferedText) as ChatCompletionsResponse;
      } catch (parseErr) {
        logger.error(
          `[ELIZAOS_CLOUD] Failed to parse buffered chat completions JSON: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`
        );
      }
    }
    const text = extractChatCompletionText(data);
    const toolCalls = extractNativeToolCalls(data);
    const usage = convertNativeUsage(data.usage);
    if (usage) {
      emitModelUsageEvent(runtime, modelType, context.prompt, usage, {
        modelName: context.modelName,
        ...(() => {
          const costUsd = extractCostUsd(data.usage, response);
          return typeof costUsd === "number" ? { costUsd } : {};
        })(),
      });
    }
    if (!text.trim() && toolCalls.length === 0) {
      throw new Error("elizaOS Cloud returned no text or tool calls");
    }
    async function* single(): AsyncGenerator<string> {
      if (text) yield text;
    }
    return {
      textStream: single(),
      text: Promise.resolve(text),
      usage: Promise.resolve(usage),
      finishReason: Promise.resolve(data.choices?.[0]?.finish_reason),
      toolCalls: Promise.resolve(toolCalls),
      providerMetadata: { modelName: context.modelName, usage: data.usage },
    };
  }

  const body = response.body as ReadableStream<Uint8Array>;
  const toolAcc = new Map<number, StreamingToolCallAcc>();
  let accumulated = "";
  let nativeUsage: NativeTokenUsage | undefined;
  let rawUsage: unknown;
  let finishReason: string | undefined;

  const textD = deferred<string>();
  const usageD = deferred<TokenUsage | undefined>();
  const finishD = deferred<string | undefined>();
  const toolCallsD = deferred<NativeToolCall[]>();
  const rejectDeferreds = (reason: unknown): void => {
    textD.reject(reason);
    usageD.reject(reason);
    finishD.reject(reason);
    toolCallsD.reject(reason);
  };

  // Stage-1 RESPONSE_HANDLER forces `tool_choice:"required"`, so Cerebras returns
  // the whole reply envelope (incl. `replyText`) as tool-call ARGUMENT deltas —
  // never `delta.content`. Surface those into the textStream so the runtime's
  // ResponseSkeletonStreamExtractor can emit `replyText` token-by-token (it
  // filters to the visible reply span, so control fields never leak to the UI).
  // Gated to the structured reply path (`streamStructured`, the only caller that
  // reaches the streaming branch); planner/other native calls keep args buffered.
  // `streamedReplyArgs` tracks what we've already surfaced so the Cerebras final
  // aggregated re-send (which replaces the accumulator) is not re-emitted twice.
  const streamReplyToolArgs =
    (params as { streamStructured?: boolean }).streamStructured === true;
  let streamedReplyArgs = "";

  async function* generate(): AsyncGenerator<string> {
    let completed = false;
    let failed = false;
    try {
      for await (const frame of parseOpenAiSseStream(body)) {
        if (frame.error) {
          const message = asRecord(frame.error).message;
          const providerError = new Error(
            typeof message === "string" && message.trim()
              ? message.trim()
              : "elizaOS Cloud stream error"
          );
          throw invalidNativeStream("provider returned an error frame", providerError);
        }
        if (!Array.isArray(frame.choices)) {
          throw invalidNativeStream("each stream frame requires a choices array");
        }
        if (frame.choices.length > 1) {
          throw invalidNativeStream("stream frame contains multiple choices");
        }
        if (frame.choices.length === 0) {
          if (frame.usage === undefined) {
            throw invalidNativeStream("stream frame has neither a choice nor usage");
          }
          if (!isRecord(frame.usage)) {
            throw invalidNativeStream("stream usage must be an object");
          }
          rawUsage = frame.usage;
          nativeUsage = convertNativeUsage(frame.usage);
          continue;
        }
        if (finishReason !== undefined) {
          throw invalidNativeStream("received a choice after the terminal finish frame");
        }
        const rawChoice = frame.choices[0];
        if (!isRecord(rawChoice)) {
          throw invalidNativeStream("stream choice must be an object");
        }
        const choice = rawChoice;
        if (
          typeof choice.index !== "number" ||
          !Number.isInteger(choice.index) ||
          choice.index < 0
        ) {
          throw invalidNativeStream("stream choice requires a non-negative integer index");
        }
        if (choice.index !== 0) {
          throw invalidNativeStream("stream returned an unexpected choice index");
        }
        if (choice.delta !== undefined && !isRecord(choice.delta)) {
          throw invalidNativeStream("stream choice delta must be an object");
        }
        const delta = asRecord(choice.delta);
        const finishValue = choice.finish_reason;
        if (
          finishValue !== undefined &&
          finishValue !== null &&
          firstString(finishValue) === undefined
        ) {
          throw invalidNativeStream("stream finish_reason must be a non-empty string or null");
        }
        const frameFinishReason = firstString(finishValue);
        if (Object.keys(delta).length === 0 && frameFinishReason === undefined) {
          throw invalidNativeStream("stream choice has neither a delta nor finish_reason");
        }
        // Raw (un-trimmed) content — inter-token whitespace is significant.
        // Structured Stage-1 streams must start with the tool-argument envelope;
        // compatible providers that narrate before the forced tool call would
        // otherwise flip the runtime extractor into plaintext passthrough.
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") {
            throw invalidNativeStream("stream content delta must be a string or null");
          }
          if (delta.content.length > 0 && !streamReplyToolArgs) {
            accumulated += delta.content;
            yield delta.content;
          }
        }
        if (delta.tool_calls !== undefined) {
          accumulateToolCallDeltas(toolAcc, delta.tool_calls);
          if (streamReplyToolArgs) {
            const replyArgs = lowestIndexToolCallArgs(toolAcc);
            if (
              replyArgs.length > streamedReplyArgs.length &&
              replyArgs.startsWith(streamedReplyArgs)
            ) {
              const suffix = replyArgs.slice(streamedReplyArgs.length);
              streamedReplyArgs = replyArgs;
              accumulated += suffix;
              yield suffix;
            } else if (replyArgs && replyArgs !== streamedReplyArgs) {
              // Aggregated re-send replaced the accumulator (possibly with a
              // case-divergent copy); the incremental preview is already on the
              // wire — advance the cursor without re-streaming a duplicate.
              streamedReplyArgs = replyArgs;
            }
          }
        }
        if (frameFinishReason) {
          finishReason = frameFinishReason;
        }
        if (frame.usage !== undefined && frame.usage !== null) {
          if (!isRecord(frame.usage)) {
            throw invalidNativeStream("stream usage must be an object or null");
          }
          rawUsage = frame.usage;
          nativeUsage = convertNativeUsage(frame.usage);
        }
      }
      if (!finishReason) {
        throw invalidNativeStream("stream ended without a terminal finish frame");
      }
      const toolCalls = finalizeStreamedToolCalls(toolAcc);
      if (!accumulated.trim() && toolCalls.length === 0) {
        throw invalidNativeStream("stream completed without text or tool calls");
      }
      completed = true;
      textD.resolve(accumulated);
      usageD.resolve(nativeUsage);
      finishD.resolve(finishReason);
      toolCallsD.resolve(toolCalls);
    } catch (error) {
      // error-policy:J1 this generator is the boundary shared by textStream and
      // its deferred result fields, so one transport failure must reject all of
      // them before the original error propagates to the stream consumer.
      failed = true;
      rejectDeferreds(error);
      throw error;
    } finally {
      releasePermit();
      if (!completed && !failed) {
        rejectDeferreds(streamCancellationError(signal));
      }
      if (nativeUsage) {
        emitModelUsageEvent(runtime, modelType, context.prompt, nativeUsage, {
          modelName: context.modelName,
          ...(() => {
            const costUsd = extractCostUsd(rawUsage, response);
            return typeof costUsd === "number" ? { costUsd } : {};
          })(),
        });
      }
    }
  }

  return {
    textStream: generate(),
    text: textD.promise,
    usage: usageD.promise,
    finishReason: finishD.promise,
    toolCalls: toolCallsD.promise,
    providerMetadata: { modelName: context.modelName },
  };
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_SMALL_MODEL_TYPE, params);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_NANO_MODEL_TYPE, params);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_MEDIUM_MODEL_TYPE, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_LARGE_MODEL_TYPE, params);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_MEGA_MODEL_TYPE, params);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, RESPONSE_HANDLER_MODEL_TYPE, params);
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ACTION_PLANNER_MODEL_TYPE, params);
}
