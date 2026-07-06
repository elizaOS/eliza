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
  logger,
  ModelType,
  recordInferenceSpan,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
  Semaphore,
  timeInferenceSpan,
} from "@elizaos/core";
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
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TEXT_TIMEOUT_MS;
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
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NATIVE_CONCURRENCY;
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

function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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
    if (systemPrompt && first.role !== "system") {
      return [{ role: "system", content: systemPrompt }, ...messages];
    }
    return messages;
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
  systemPrompt?: string
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
  const rawCalls = data.choices?.[0]?.message?.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) {
    return [];
  }

  return rawCalls
    .map<NativeToolCall | undefined>((rawCall) => {
      const call = asRecord(rawCall);
      const fn = recordAt(call, "function");
      const toolName = firstString(call.name, call.toolName, fn.name);
      if (!toolName) {
        return undefined;
      }
      return {
        type: "tool-call",
        toolCallId: firstString(call.id, call.toolCallId) ?? `call_${toolName}`,
        toolName,
        input: parseJsonIfPossible(call.input ?? call.arguments ?? fn.arguments ?? {}),
      };
    })
    .filter((call): call is NativeToolCall => call !== undefined);
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
  logger.log(prompt);

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

  const responsesHeaders: Record<string, string> = {
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
  };
  if (isSpanSamplerHonoringModel(modelName)) {
    const samplerHeader = buildSpanSamplerHeader(params.spanSamplerPlan);
    if (samplerHeader) {
      responsesHeaders["x-eliza-span-samplers"] = samplerHeader;
    }
  }
  // Same shared cerebras key as the /chat/completions route, so gate this
  // bare-prompt round-trip through the SAME limiter (parsing stays unguarded).
  const response = await withNativeChatLimit(
    () =>
      createCloudApiClient(runtime).requestRaw("POST", "/responses", {
        headers: responsesHeaders,
        json: requestBody,
        timeoutMs: resolveTextTimeoutMs(),
      }),
    "responses"
  );
  const responseText = await response.text();
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
    context.systemPrompt
  );
  const headers: Record<string, string> = {
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
  };
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
  // round-trip; the text()/JSON parse below runs unguarded.
  const response = await withNativeChatLimit(
    () =>
      createCloudApiClient(runtime).requestRaw("POST", "/chat/completions", {
        headers,
        json: requestBody,
        timeoutMs: resolveTextTimeoutMs(),
      }),
    "chat/completions"
  );
  const responseText = await response.text();
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
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Parse an OpenAI-compatible SSE byte stream into the decoded JSON frame of
 * each `data:` line. Yields one object per frame; stops at `data: [DONE]`.
 * Tolerates partial reads (buffers across chunk boundaries) and ignores
 * non-`data:` lines (comments, blank separators). Exported for unit tests.
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
    if (payload === "") return null;
    if (payload === "[DONE]") return "DONE";
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return null;
    }
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
    const tail = handle(buffer);
    if (tail && tail !== "DONE") yield tail;
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
      // Reader already cancelled/released by an upstream abort — nothing to do.
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
function isCompleteJsonObject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

/** Fold one SSE `delta.tool_calls[]` array into the per-index accumulator. */
export function accumulateToolCallDeltas(
  acc: Map<number, StreamingToolCallAcc>,
  deltas: unknown
): void {
  if (!Array.isArray(deltas)) return;
  for (const raw of deltas) {
    const d = asRecord(raw);
    const index = typeof d.index === "number" ? d.index : 0;
    const cur = acc.get(index) ?? { args: "" };
    const id = firstString(d.id);
    if (id) cur.id = id;
    const fn = recordAt(d, "function");
    const name = firstString(fn.name);
    if (name) cur.name = name;
    if (typeof fn.arguments === "string") {
      // Cerebras streams the tool-call arguments incrementally, then emits a
      // FINAL aggregated frame that re-sends the COMPLETE arguments object
      // (re-carrying id + name). Blindly appending that re-send doubles the
      // JSON (`{…}{…}`); downstream parsing can only recover when both copies
      // are byte-identical, and the cloud character ("lowercase naturally")
      // makes the copies diverge on casing — dead-ending terse replies. When
      // the accumulated args AND the incoming fragment are each a complete,
      // self-contained object the incoming is the authoritative full copy:
      // replace rather than concatenate.
      if (isCompleteJsonObject(cur.args) && isCompleteJsonObject(fn.arguments)) {
        cur.args = fn.arguments;
      } else {
        cur.args += fn.arguments;
      }
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
  for (const [index, c] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    out.push({
      type: "tool-call",
      toolCallId: c.id ?? `call_${c.name}_${index}`,
      toolName: c.name,
      input: parseJsonIfPossible(c.args.trim() === "" ? "{}" : c.args),
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
    context.systemPrompt
  );
  requestBody.stream = true;
  // OpenAI-compatible: ask the server to include a final usage-only frame so we
  // can meter the streamed call accurately.
  requestBody.stream_options = { include_usage: true };

  const headers: Record<string, string> = {
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
  };
  if (isSpanSamplerHonoringModel(context.modelName)) {
    const samplerHeader = buildSpanSamplerHeader(params.spanSamplerPlan);
    if (samplerHeader) {
      headers["x-eliza-span-samplers"] = samplerHeader;
    }
  }

  const abortSignal = (params as { signal?: AbortSignal }).signal;
  const signal = buildStreamAbortSignal(abortSignal, resolveTextTimeoutMs());

  const limiter = getNativeChatLimiter();
  const waitStartedAt = Date.now();
  await limiter.acquire();
  recordInferenceSpan("cloud.semaphore-wait", Date.now() - waitStartedAt, {
    route: "chat/completions:stream",
  });
  let permitReleased = false;
  const releasePermit = (): void => {
    if (!permitReleased) {
      permitReleased = true;
      limiter.release();
    }
  };

  let response: Response;
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
    try {
      for await (const frame of parseOpenAiSseStream(body)) {
        if (frame.error) {
          const message = asRecord(frame.error).message;
          throw new Error(
            typeof message === "string" && message.trim()
              ? message.trim()
              : "elizaOS Cloud stream error"
          );
        }
        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        const choice = asRecord(choices[0]);
        const delta = recordAt(choice, "delta");
        // Raw (un-trimmed) content — inter-token whitespace is significant.
        if (typeof delta.content === "string" && delta.content.length > 0) {
          accumulated += delta.content;
          yield delta.content;
        }
        if (delta.tool_calls) {
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
        const fr = firstString(choice.finish_reason);
        if (fr) finishReason = fr;
        if (frame.usage) {
          rawUsage = frame.usage;
          nativeUsage = convertNativeUsage(frame.usage);
        }
      }
    } finally {
      releasePermit();
      const toolCalls = finalizeStreamedToolCalls(toolAcc);
      textD.resolve(accumulated);
      usageD.resolve(nativeUsage);
      finishD.resolve(finishReason);
      toolCallsD.resolve(toolCalls);
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
