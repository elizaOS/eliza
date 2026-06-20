import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
  TokenUsage,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  logger,
  ModelType,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
  Semaphore,
} from "@elizaos/core";
import type { LanguageModel } from "ai";
import { createOpenAIClient } from "../providers/openai";
import {
  getActionPlannerModel,
  getExperimentalTelemetry,
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
 */
export async function withNativeChatLimit<T>(fn: () => Promise<T>): Promise<T> {
  const limiter = getNativeChatLimiter();
  await limiter.acquire();
  try {
    return await fn();
  } finally {
    limiter.release();
  }
}

/**
 * Acquire a permit on the shared native cap and return a release handle. Used by
 * the streaming path, where the permit must be HELD for the full SSE lifetime
 * (the body keeps draining the cerebras key long after the response headers
 * arrive), not just the `requestRaw` round-trip. The returned `release` is
 * idempotent so the caller can free the permit on the first of {stream-done,
 * stream-error, early-abort} without risk of double-release inflating the
 * budget. Pairs with {@link withNativeChatLimit} on the SAME limiter so a
 * streaming call and a buffered call still contend on one budget.
 */
async function acquireNativeChatPermit(): Promise<{ release: () => void }> {
  const limiter = getNativeChatLimiter();
  await limiter.acquire();
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      limiter.release();
    },
  };
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
const RESPONSES_ROUTED_PREFIXES = ["openai/", "anthropic/"] as const;
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
 * One streaming `chat.completion.chunk` from the cloud SSE feed. We only read
 * the incremental `delta.content` text and the terminal `finish_reason`; the
 * gateway also emits a trailing chunk carrying `usage` (when
 * `stream_options.include_usage` is set), which we surface for metering.
 */
type ChatCompletionStreamChunk = Record<string, unknown> & {
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown> | null;
};

function buildUserContent(params: GenerateTextParamsWithAttachments) {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "file";
        data: string | Uint8Array | URL;
        mediaType: string;
        filename?: string;
      }
  > = [{ type: "text", text: params.prompt ?? "" }];

  for (const attachment of params.attachments ?? []) {
    content.push({
      type: "file",
      data: attachment.data,
      mediaType: attachment.mediaType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }

  return content;
}

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

function supportsStopSequences(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return !RESPONSES_ROUTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
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

function normalizeNativeToolChoice(toolChoice: unknown): unknown {
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
    return toolChoice;
  }
  if (choice.type === "tool") {
    const toolName = firstString(choice.toolName, choice.name);
    return toolName ? { type: "function", function: { name: toolName } } : toolChoice;
  }

  const functionChoice = asRecord(choice.function);
  const toolName = firstString(choice.toolName, choice.name, functionChoice.name);
  return toolName ? { type: "function", function: { name: toolName } } : toolChoice;
}

function buildNativeResponseFormat(responseSchema: unknown): unknown {
  if (!responseSchema) {
    return undefined;
  }

  const schemaRecord = asRecord(responseSchema);
  if (schemaRecord.responseFormat) {
    return schemaRecord.responseFormat;
  }

  const schemaOptions =
    "schema" in schemaRecord
      ? {
          schema: schemaRecord.schema,
          name: firstString(schemaRecord.name) ?? "structured_response",
          description: firstString(schemaRecord.description),
        }
      : { schema: responseSchema, name: "structured_response", description: undefined };

  return {
    type: "json_schema",
    json_schema: {
      name: schemaOptions.name,
      ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
      schema: schemaOptions.schema,
    },
  };
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
  const responseFormat = buildNativeResponseFormat(params.responseSchema);
  const requestBody: Record<string, unknown> = {
    model: modelName,
    messages: buildNativeMessages(params, promptText, systemPrompt),
    max_tokens: params.maxTokens ?? 8192,
  };

  if (!isReasoningModel(modelName) && typeof params.temperature === "number") {
    requestBody.temperature = params.temperature;
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

function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
) {
  const paramsWithAttachments = params as GenerateTextParamsWithAttachments;
  const prompt = params.prompt ?? "";
  const maxTokens = params.maxTokens ?? 8192;

  const openai = createOpenAIClient(runtime);
  const modelName = getModelNameForType(runtime, modelType);
  const experimentalTelemetry = getExperimentalTelemetry(runtime);
  const userContent =
    (paramsWithAttachments.attachments?.length ?? 0) > 0
      ? buildUserContent(paramsWithAttachments)
      : undefined;

  // Use openai.chat() (Chat Completions API) instead of openai.languageModel()
  // (Responses API). The Responses API unconditionally rejects presencePenalty,
  // frequencyPenalty, and stopSequences for ALL models, emitting noisy warnings.
  // The Chat Completions API supports these features natively and handles
  // reasoning models gracefully when the params are omitted.
  const model = openai.chat(modelName) as LanguageModel;

  // Reasoning models don't support temperature, frequency/presence penalties,
  // or stopSequences. Detect via model name patterns.
  const reasoning = isReasoningModel(modelName);
  const stopSequences =
    !reasoning &&
    supportsStopSequences(modelName) &&
    Array.isArray(params.stopSequences) &&
    params.stopSequences.length > 0
      ? params.stopSequences
      : undefined;
  const systemPrompt = resolveEffectiveSystemPrompt({
    params,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
  const promptText =
    renderChatMessagesForPrompt(params.messages, {
      omitDuplicateSystem: systemPrompt,
    }) ?? prompt;

  const generateParams = {
    model,
    ...(userContent
      ? { messages: [{ role: "user" as const, content: userContent }] }
      : { prompt: promptText }),
    system: systemPrompt,
    ...(stopSequences ? { stopSequences } : {}),
    maxOutputTokens: maxTokens,
    experimental_telemetry: {
      isEnabled: experimentalTelemetry,
    },
  };

  return { generateParams, modelName, modelType, prompt: promptText, systemPrompt };
}

/**
 * Pull every `delta.content` text fragment + the terminal usage/finish_reason
 * out of an OpenAI-style SSE `chat.completion.chunk` line. The cloud
 * `/chat/completions?stream=true` feed is line-delimited `data: {json}` events
 * terminated by a `data: [DONE]` sentinel. Returns nothing for keep-alive
 * comments / blank lines / the sentinel.
 */
function parseStreamLine(line: string): {
  text?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
} | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }
  let chunk: ChatCompletionStreamChunk;
  try {
    chunk = JSON.parse(payload) as ChatCompletionStreamChunk;
  } catch {
    // A partial JSON payload here means the SSE framing was split mid-line; the
    // caller buffers across reads, so a parse failure on a complete line is a
    // genuinely malformed event we skip rather than crash the stream.
    return null;
  }
  const choice = chunk.choices?.[0];
  const deltaContent = choice?.delta?.content;
  const text = typeof deltaContent === "string" ? deltaContent : undefined;
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  const usage = isRecord(chunk.usage) ? chunk.usage : undefined;
  if (text === undefined && finishReason === undefined && usage === undefined) {
    return null;
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Stream a PLAIN-PROMPT cloud reply via `/chat/completions` with `stream:true`,
 * parsing the SSE delta chunks into a {@link TextStreamResult} the runtime's
 * streaming `useModel` path consumes. The native concurrency permit is acquired
 * BEFORE the request and held for the FULL stream duration (the body keeps the
 * cerebras key busy until the last chunk), then released exactly once on
 * completion or error so a streaming call can never reintroduce the 429 burst.
 *
 * Throws synchronously (before returning the result) when the request can't be
 * established or the body is missing, so the caller can fall back to the
 * buffered path without dropping the turn. Errors that surface mid-stream are
 * propagated through `textStream` (and the `text` promise) — the permit is still
 * released in that case.
 */
async function streamNativeChatCompletion(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams,
  context: { modelName: string; prompt: string; systemPrompt?: string }
): Promise<TextStreamResult> {
  const reasoning = isReasoningModel(context.modelName);
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  messages.push({ role: "user", content: context.prompt });

  const requestBody: Record<string, unknown> = {
    model: context.modelName,
    messages,
    max_tokens: params.maxTokens ?? 8192,
    stream: true,
    // Ask the gateway to emit a terminal usage chunk so streaming turns are
    // still metered exactly like the buffered path.
    stream_options: { include_usage: true },
  };
  if (!reasoning && typeof params.temperature === "number") {
    requestBody.temperature = params.temperature;
  }

  const headers: Record<string, string> = {
    "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
    "X-Eliza-Model-Type": modelType,
    Accept: "text/event-stream",
  };
  if (isSpanSamplerHonoringModel(context.modelName)) {
    const samplerHeader = buildSpanSamplerHeader(params.spanSamplerPlan);
    if (samplerHeader) {
      headers["x-eliza-span-samplers"] = samplerHeader;
    }
  }

  // Hold the permit across the whole stream, not just the round-trip — release
  // on the first of {done, error}. Acquired before the request so a stream
  // contends on the SAME budget as buffered calls.
  const permit = await acquireNativeChatPermit();

  let response: Response;
  try {
    response = await createCloudApiClient(runtime).requestRaw("POST", "/chat/completions", {
      headers,
      json: requestBody,
    });
  } catch (err) {
    permit.release();
    throw err;
  }

  if (!response.ok) {
    permit.release();
    const errorText = await response.text().catch(() => "");
    let errorMessage = `elizaOS Cloud error ${response.status}`;
    if (errorText) {
      try {
        const parsed = JSON.parse(errorText) as { error?: { message?: string } };
        if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
          errorMessage = parsed.error.message.trim();
        }
      } catch {
        // Non-JSON error body — keep the status-based message.
      }
    }
    const requestError = new Error(errorMessage) as Error & { status?: number };
    requestError.status = response.status;
    throw requestError;
  }

  const body = response.body;
  if (!body) {
    permit.release();
    throw new Error("elizaOS Cloud returned no streaming body");
  }

  const queue: string[] = [];
  let pendingResolve: ((value: IteratorResult<string>) => void) | null = null;
  let pendingReject: ((reason: unknown) => void) | null = null;
  let streamError: unknown = null;
  let streamDone = false;
  let accumulated = "";
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;

  const drain = (): void => {
    if (!pendingResolve) {
      return;
    }
    if (queue.length > 0) {
      const next = queue.shift() as string;
      const resolver = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      resolver({ value: next, done: false });
      return;
    }
    if (streamError && pendingReject) {
      const rejector = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      rejector(streamError);
      return;
    }
    if (streamDone) {
      const resolver = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      resolver({ value: undefined as unknown as string, done: true });
    }
  };

  const ingestLine = (line: string): void => {
    const parsed = parseStreamLine(line);
    if (!parsed) {
      return;
    }
    if (parsed.usage) {
      usage = convertNativeUsage(parsed.usage);
    }
    if (parsed.finishReason) {
      finishReason = parsed.finishReason;
    }
    if (parsed.text) {
      accumulated += parsed.text;
      queue.push(parsed.text);
      drain();
    }
  };

  // Drive the SSE feed off the response body. Buffer across reads so an event
  // split over two chunks is parsed once whole. Release the permit + emit usage
  // exactly once when the feed ends (cleanly or with an error).
  const pump = (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          ingestLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        ingestLine(buffer);
      }
      if (!accumulated.trim()) {
        throw new Error("elizaOS Cloud returned no streamed text");
      }
      if (usage) {
        emitModelUsageEvent(runtime, modelType, context.prompt, usage, {
          modelName: context.modelName,
          ...(() => {
            const costUsd = extractCostUsd(usage, response);
            return typeof costUsd === "number" ? { costUsd } : {};
          })(),
        });
      }
    } catch (err) {
      streamError = err;
      throw err;
    } finally {
      streamDone = true;
      permit.release();
      drain();
    }
  })();

  // Single settled view of the pump: the post-stream summary promises derive
  // from THIS (never-rejecting) promise so an unconsumed `text`/`usage`/
  // `finishReason` can't surface as an unhandled rejection. Consumers that
  // iterate `textStream` still see a mid-stream error there; `text` resolves to
  // whatever partial text accumulated, matching the runtime streaming contract
  // (the error is observed via the iterator, not the summary promise).
  const settled = pump.then(
    () => ({ ok: true as const }),
    (err) => ({ ok: false as const, err })
  );

  const textStream: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            const next = queue.shift() as string;
            return Promise.resolve({ value: next, done: false });
          }
          if (streamError) {
            return Promise.reject(streamError);
          }
          if (streamDone) {
            return Promise.resolve({
              value: undefined as unknown as string,
              done: true,
            });
          }
          return new Promise<IteratorResult<string>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
      };
    },
  };

  return {
    textStream,
    text: settled.then(() => accumulated),
    usage: settled.then((s) => (s.ok ? usage : undefined)),
    finishReason: settled.then((s) => (s.ok ? (finishReason ?? "stop") : undefined)),
    providerMetadata: { modelName: context.modelName },
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const { modelName, prompt, systemPrompt } = buildGenerateParams(runtime, modelType, params);
  const paramsWithNative = params as GenerateTextParamsWithNativeOptions;

  logger.debug(`[ELIZAOS_CLOUD] Generating text with ${modelType} model: ${modelName}`);

  logger.log(`[ELIZAOS_CLOUD] Using ${modelType} model: ${modelName}`);
  logger.log(prompt);

  if (hasNativeTransportOptions(paramsWithNative)) {
    const nativeResult = await generateNativeChatCompletion(runtime, modelType, paramsWithNative, {
      modelName,
      prompt,
      systemPrompt,
    });
    return shouldReturnNativeResult(paramsWithNative)
      ? (nativeResult as NativeGenerateTextModelResult)
      : nativeResult.text;
  }

  // Plain-prompt path: when streaming is requested, stream tokens incrementally
  // via /chat/completions so the user sees text appear instead of a multi-second
  // blank wait. The native-transport (tools/schema/messages/providerOptions)
  // calls above keep the buffered round-trip. On any streaming setup error we
  // fall back to the buffered /responses path below so the turn is never dropped.
  if (params.stream) {
    try {
      return await streamNativeChatCompletion(runtime, modelType, params, {
        modelName,
        prompt,
        systemPrompt,
      });
    } catch (err) {
      logger.warn(
        `[ELIZAOS_CLOUD] Streaming text failed (${
          err instanceof Error ? err.message : String(err)
        }); falling back to buffered response.`
      );
    }
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
    max_output_tokens: params.maxTokens ?? 8192,
  };
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
  const response = await withNativeChatLimit(() =>
    createCloudApiClient(runtime).requestRaw("POST", "/responses", {
      headers: responsesHeaders,
      json: requestBody,
    })
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
  const response = await withNativeChatLimit(() =>
    createCloudApiClient(runtime).requestRaw("POST", "/chat/completions", {
      headers,
      json: requestBody,
    })
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
