/**
 * Text generation model handlers
 *
 * Provides text generation using OpenAI's language models.
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ModelTypeName,
  RecordLlmCallDetails,
} from "@elizaos/core";
import {
  assertActiveTrajectoryForLlmCall,
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
  logActiveTrajectoryLlmCall,
  logger,
  ModelType,
  normalizeSchemaForCerebras,
  recordLlmCall,
  resolveEffectiveSystemPrompt,
  sanitizeFunctionNameForCerebras,
} from "@elizaos/core";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  streamText,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";
import { createOpenAIClient } from "../providers";
import type { TextStreamResult, TokenUsage } from "../types";
import {
  getActionPlannerModel,
  getExperimentalTelemetry,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
  isCerebrasMode,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

// ============================================================================
// Types
// ============================================================================

/**
 * Function to get model name from runtime
 */
type ModelNameGetter = (runtime: IAgentRuntime) => string;

type PromptCacheRetention = "in_memory" | "24h";
type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

interface OpenAIPromptCacheOptions {
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
}

interface GenerateTextParamsWithOpenAIOptions
  extends Omit<
    GenerateTextParams,
    "messages" | "tools" | "toolChoice" | "responseSchema" | "providerOptions"
  > {
  model?: string;
  attachments?: ChatAttachment[];
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  responseSchema?: unknown;
  providerOptions?: Record<string, object | JsonValue> & {
    agentName?: string;
    openai?: OpenAIPromptCacheOptions;
  };
}

type NativeOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;
type NativeGenerateTextParams = Parameters<typeof generateText<ToolSet, NativeOutput>>[0];
type NativeStreamTextParams = Parameters<typeof streamText<ToolSet, NativeOutput>>[0];
type NativePrompt =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };
type NativeTextParams = Omit<NativeGenerateTextParams, "messages" | "prompt"> &
  Omit<NativeStreamTextParams, "messages" | "prompt"> &
  NativePrompt & {
    // Re-declared explicitly: TypeScript's `Parameters<typeof generateText>`
    // inference produces an overload-union that drops this field, but the
    // ai SDK's runtime signature accepts it (see ai@6 `CallSettings & Prompt`).
    allowSystemInMessages?: boolean;
  };
type NativeProviderOptions = NativeTextParams["providerOptions"];
type NativeTelemetrySettings = NativeTextParams["experimental_telemetry"];

type LanguageModelUsageWithCache = Omit<LanguageModelUsage, "inputTokenDetails"> & {
  inputTokenDetails?: LanguageModelUsage["inputTokenDetails"] & {
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheCreationTokens?: number;
  };
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheWriteInputTokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

interface NativeGenerateTextResult {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: TokenUsage;
  providerMetadata?: unknown;
}

type NativeTextModelResult = string & NativeGenerateTextResult;
type RecordArgValueMode = "json-string" | "schema";

interface RecordArgTransform {
  path: string;
  entriesKey: string;
  valueMode: RecordArgValueMode;
}

interface NormalizedNativeToolsResult {
  tools?: ToolSet;
  recordArgTransformsByTool: Record<string, RecordArgTransform[]>;
}

const TEXT_NANO_MODEL_TYPE = ModelType.TEXT_NANO as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = ModelType.TEXT_MEDIUM as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = ModelType.TEXT_MEGA as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = ModelType.RESPONSE_HANDLER as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = ModelType.ACTION_PLANNER as ModelTypeName;

function resolveRequestedModelName(
  params: GenerateTextParamsWithOpenAIOptions,
  runtime: IAgentRuntime,
  getModelFn: ModelNameGetter
): string {
  return typeof params.model === "string" && params.model.trim().length > 0
    ? params.model.trim()
    : getModelFn(runtime);
}

function buildUserContent(params: GenerateTextParamsWithOpenAIOptions): UserContent {
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

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts AI SDK usage to our token usage format.
 *
 * Emits both the legacy `cachedPromptTokens` (kept for back-compat with
 * existing OpenAI consumers) and the canonical v5 `cacheReadInputTokens`
 * (consumed by the trajectory recorder + cost table). They always carry the
 * same value when the AI SDK reports cached input.
 */
function convertUsage(usage: LanguageModelUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  // The AI SDK uses inputTokens/outputTokens
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const usageWithCache: LanguageModelUsageWithCache = usage;
  const cachedInput =
    firstNumber(
      usageWithCache.cacheReadInputTokens,
      usageWithCache.cachedInputTokens,
      usageWithCache.inputTokenDetails?.cacheReadTokens,
      usageWithCache.inputTokenDetails?.cachedInputTokens,
      usageWithCache.input_tokens_details?.cache_read_input_tokens,
      usageWithCache.input_tokens_details?.cached_tokens,
      usageWithCache.prompt_tokens_details?.cached_tokens
    ) ?? undefined;
  const cacheCreationInput = firstNumber(
    usageWithCache.cacheCreationInputTokens,
    usageWithCache.cacheWriteInputTokens,
    usageWithCache.inputTokenDetails?.cacheCreationInputTokens,
    usageWithCache.inputTokenDetails?.cacheCreationTokens,
    usageWithCache.inputTokenDetails?.cacheWriteTokens,
    usageWithCache.input_tokens_details?.cache_creation_input_tokens
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: cachedInput,
    cacheReadInputTokens: cachedInput,
    cacheCreationInputTokens: cacheCreationInput,
  };
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

function resolvePromptCacheOptions(params: GenerateTextParams): OpenAIPromptCacheOptions {
  const withOpenAIOptions = params as GenerateTextParamsWithOpenAIOptions;
  return {
    promptCacheKey: withOpenAIOptions.providerOptions?.openai?.promptCacheKey,
    promptCacheRetention: withOpenAIOptions.providerOptions?.openai?.promptCacheRetention,
  };
}

/**
 * Forward `OPENAI_REASONING_EFFORT` (runtime setting / process.env) as
 * `reasoning_effort` on the outbound chat completions request. This is
 * the OpenAI-spec knob for reasoning-capable models (`o1-*`, `o3-*`,
 * `gpt-oss-*`, `deepseek-r1`, and similar families) — including
 * Cerebras and OpenRouter, which honor the same field. `"low"` keeps
 * reasoning short enough that visible content always fits inside
 * `max_tokens`, which is the failure mode on Cerebras gpt-oss-120b when
 * left unset.
 *
 * In Cerebras mode the field defaults to `"low"` when unset, but ONLY for
 * reasoning-capable models (e.g. gpt-oss-* and deepseek-r1):
 * gpt-oss-120b emits a separate reasoning channel and, left unbounded, spends
 * the whole token budget reasoning — returning empty visible content, which
 * makes the agent fall back to "I don't have a reply for that". `"low"` keeps
 * reasoning short so a reply always materializes. Non-reasoning Cerebras models
 * (Llama, etc.) reject `reasoning_effort`, so they must never receive the
 * default. For all other models an unset/invalid value yields `undefined`, so
 * they pay no overhead and the wire stays clean. An explicit valid
 * `OPENAI_REASONING_EFFORT` always wins.
 *
 * Valid values follow the OpenAI spec exactly: `minimal`, `low`,
 * `medium`, `high`. Anything else is logged and ignored.
 */
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

/**
 * Reasoning-capable model families that emit a separate reasoning channel and
 * honor `reasoning_effort`. Used to gate the Cerebras `"low"` default so
 * non-reasoning models (Llama, etc.) are never sent the field.
 */
function isReasoningModel(modelName: string | undefined): boolean {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  return (
    m.includes("gpt-oss") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("deepseek-r1") ||
    m.includes("thinking") ||
    m.includes("reasoning") ||
    m.includes("qwq")
  );
}

function resolveReasoningEffort(
  runtime: IAgentRuntime,
  modelName?: string
): ReasoningEffort | undefined {
  const raw = runtime.getSetting("OPENAI_REASONING_EFFORT");
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized) {
    if ((VALID_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
      return normalized as ReasoningEffort;
    }
    logger.warn(
      `[OpenAI] OPENAI_REASONING_EFFORT=${raw} is not a valid reasoning effort; ignoring. Expected one of: ${VALID_REASONING_EFFORTS.join(", ")}.`
    );
  }
  // gpt-oss-120b on Cerebras returns empty content when reasoning runs
  // unbounded; default to "low" so a visible reply always fits — but only for
  // reasoning-capable models. Non-reasoning Cerebras models (Llama, etc.)
  // reject `reasoning_effort` and would break. An explicit valid value above
  // wins over this default.
  if (isCerebrasMode(runtime) && isReasoningModel(modelName)) {
    return "low";
  }
  return undefined;
}

function resolveProviderOptions(
  params: GenerateTextParams,
  runtime: IAgentRuntime,
  modelName?: string
): Record<string, unknown> | undefined {
  const withOpenAIOptions = params as GenerateTextParamsWithOpenAIOptions;
  const rawProviderOptions = withOpenAIOptions.providerOptions;
  const promptCacheOptions = resolvePromptCacheOptions(params);
  const reasoningEffort = resolveReasoningEffort(runtime, modelName);

  if (
    !rawProviderOptions &&
    !promptCacheOptions.promptCacheKey &&
    !promptCacheOptions.promptCacheRetention &&
    !reasoningEffort
  ) {
    return undefined;
  }

  // Cerebras supports prompt caching on gpt-oss-120b — 128-token blocks,
  // default-on. The `prompt_cache_key` field IS accepted by Cerebras's
  // OpenAI-compatible endpoint and surfaces hit counts via
  // `usage.prompt_tokens_details.cached_tokens` (same shape as OpenAI), so
  // we keep it in the request body. Only `prompt_cache_retention` is an
  // OpenAI-direct-only field that Cerebras rejects with HTTP 400
  // (`wrong_api_format`), so we strip just that one when in Cerebras mode.
  const skipCacheRetention = isCerebrasMode(runtime);

  const { agentName: _agentName, openai: rawOpenAIOptions, ...rest } = rawProviderOptions ?? {};
  // When on Cerebras, scrub OpenAI-direct-only fields (e.g. `promptCacheRetention`)
  // from `rawOpenAIOptions` before they're spread; otherwise they reach the wire
  // and the Cerebras endpoint rejects with HTTP 400 `wrong_api_format`.
  const sanitizedRawOpenAIOptions = (() => {
    if (!rawOpenAIOptions || typeof rawOpenAIOptions !== "object") return rawOpenAIOptions;
    if (!skipCacheRetention) return rawOpenAIOptions;
    const { promptCacheRetention: _drop, ...rest2 } = rawOpenAIOptions as Record<string, unknown>;
    return rest2;
  })();
  const openaiOptions = {
    ...(sanitizedRawOpenAIOptions ?? {}),
    ...(promptCacheOptions.promptCacheKey
      ? { promptCacheKey: promptCacheOptions.promptCacheKey }
      : {}),
    ...(!skipCacheRetention && promptCacheOptions.promptCacheRetention
      ? { promptCacheRetention: promptCacheOptions.promptCacheRetention }
      : {}),
    // The caller's explicit `reasoningEffort` wins over the resolved default
    // (env var, or Cerebras "low") — same precedence pattern as promptCacheKey.
    ...((sanitizedRawOpenAIOptions as { reasoningEffort?: unknown } | undefined)
      ?.reasoningEffort === undefined && reasoningEffort
      ? { reasoningEffort }
      : {}),
  };

  const providerOptions = {
    ...rest,
    ...(Object.keys(openaiOptions).length > 0 ? { openai: openaiOptions } : {}),
  };

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

function buildStructuredOutput(responseSchema: unknown): NativeOutput {
  if (
    responseSchema &&
    typeof responseSchema === "object" &&
    "responseFormat" in responseSchema &&
    "parseCompleteOutput" in responseSchema
  ) {
    return responseSchema as NativeOutput;
  }

  const schemaOptions =
    responseSchema && typeof responseSchema === "object" && "schema" in responseSchema
      ? (responseSchema as { schema: unknown; name?: string; description?: string })
      : { schema: responseSchema };

  return Output.object({
    schema: jsonSchema(sanitizeJsonSchema(schemaOptions.schema, true)),
    ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
    ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
  }) as NativeOutput;
}

/**
 * Native tool normalization plus the strict-safe record/map transform selected
 * for #13111. Tool schemas still close every object with additionalProperties:
 * false for strict-grammar providers (#11123/#11156), but a DECLARED open map
 * gets a model-facing `__eliza_record_entries` key/value array. Returned tool
 * calls are reverse-mapped before the runtime validates against the original
 * schema, so tool authors still receive the object shape they declared.
 */
function normalizeNativeToolsForCall(
  tools: unknown,
  options: { cerebrasMode?: boolean } = {}
): NormalizedNativeToolsResult {
  const recordArgTransformsByTool: Record<string, RecordArgTransform[]> = {};

  if (!tools) {
    return { recordArgTransformsByTool };
  }

  // Existing AI SDK callers already pass a ToolSet keyed by tool name. Keep it
  // intact so custom tool instances, execute hooks, and dynamic tool metadata
  // are preserved.
  if (!Array.isArray(tools)) {
    return { tools: tools as ToolSet, recordArgTransformsByTool };
  }

  const toolSet: Record<string, unknown> = {};

  for (const rawTool of tools) {
    const tool = asRecord(rawTool);
    const functionTool = asRecord(tool.function);
    const name = firstString(tool.name, functionTool.name);

    if (!name) {
      throw new Error("[OpenAI] Native tool definition is missing a name.");
    }

    const description = firstString(tool.description, functionTool.description);
    // Default to a permissive object schema. The empty-properties shape
    // (`{ type: "object", properties: {}, additionalProperties: false }`) is
    // accepted by OpenAI but rejected by strict-grammar providers like
    // Cerebras with `Object fields require at least one of: 'properties' or
    // 'anyOf' with a list of possible properties`.
    const rawSchema =
      tool.parameters ?? functionTool.parameters ?? ({ type: "object" } satisfies JSONSchema7);
    const recordArgTransforms: RecordArgTransform[] = [];
    let inputSchema = sanitizeJsonSchema(rawSchema, true, "$", recordArgTransforms);
    if (options.cerebrasMode) {
      // User-supplied schemas may still contain empty-properties subobjects
      // even after sanitizeJsonSchema. Apply Cerebras-specific normalization
      // recursively so deep schemas are accepted by the grammar compiler.
      // Pass isRoot: true so the top-level invariant is enforced (must be
      // type:"object" with no root oneOf/anyOf/enum/not).
      inputSchema = normalizeSchemaForCerebras(inputSchema, true) as JSONSchema7;
    }

    // Cerebras's grammar compiler rejects function names containing characters
    // outside `[a-zA-Z0-9_-]` (e.g. `math.factorial`). The AI SDK looks up
    // tools by the registered key, so we register under the sanitized name AND
    // surface it to the model under that name. Tool calls come back with the
    // sanitized name, which the runtime resolves through its action registry —
    // any caller relying on dotted action names should pre-sanitize.
    const registeredName = options.cerebrasMode ? sanitizeFunctionNameForCerebras(name) : name;
    if (recordArgTransforms.length > 0) {
      recordArgTransformsByTool[registeredName] = recordArgTransforms;
    }

    toolSet[registeredName] = {
      ...(description ? { description } : {}),
      inputSchema: jsonSchema(inputSchema as JSONSchema7),
    };
  }

  return {
    tools: Object.keys(toolSet).length > 0 ? (toolSet as ToolSet) : undefined,
    recordArgTransformsByTool,
  };
}

function normalizeNativeTools(
  tools: unknown,
  options: { cerebrasMode?: boolean } = {}
): ToolSet | undefined {
  return normalizeNativeToolsForCall(tools, options).tools;
}

function normalizeNativeMessages(messages: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return messages.map((message) => normalizeNativeMessage(message));
}

function normalizeNativeMessage(message: unknown): ModelMessage {
  const raw = asRecord(message);
  const providerOptions = asOptionalRecord(raw.providerOptions);

  if (raw.role === "system") {
    return {
      role: "system",
      content: stringifyMessageContent(raw.content),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  if (raw.role === "assistant") {
    return {
      role: "assistant",
      content: normalizeAssistantContent(raw),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  if (raw.role === "tool") {
    return {
      role: "tool",
      content: normalizeToolContent(raw),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  return {
    role: "user",
    content: normalizeUserContent(raw.content),
    ...(providerOptions ? { providerOptions } : {}),
  } as ModelMessage;
}

/**
 * Strip reasoning-only parts from outbound assistant content.
 *
 * OpenAI-spec reasoning models (Cerebras gpt-oss-120b, OpenAI o1/o3,
 * DeepSeek R1, and similar families) return reasoning in the assistant
 * response — either as a separate `reasoning` / `reasoning_content`
 * field, or as content parts with `type: "reasoning"`. Echoing those
 * back to the next turn is wrong on both ends:
 *   - Cerebras returns HTTP 400 (`messages.X.assistant.reasoning_content:
 *     property is unsupported`).
 *   - OpenAI silently drops them, which wastes prompt tokens.
 *
 * The AI SDK upstream of this normalizer surfaces those reasoning blocks
 * as `{ type: "reasoning", ... }` content parts. We drop them here so
 * the wire stays spec-clean for the next turn. The reasoning itself
 * remains usable as a single-turn signal (still on the response object);
 * we only refuse to round-trip it.
 */
function stripReasoningParts(content: unknown[]): unknown[] {
  return content.filter((part) => {
    if (!part || typeof part !== "object") return true;
    const type = (part as { type?: unknown }).type;
    return type !== "reasoning" && type !== "thinking";
  });
}

function normalizeAssistantContent(message: Record<string, unknown>): unknown {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];

  if (toolCalls.length === 0) {
    if (Array.isArray(message.content)) {
      return stripReasoningParts(message.content);
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    return "";
  }

  const parts: unknown[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    parts.push(...stripReasoningParts(message.content));
  }

  for (const toolCall of toolCalls) {
    const rawCall = asRecord(toolCall);
    const rawFunction = asRecord(rawCall.function);
    const toolCallId = firstString(rawCall.toolCallId, rawCall.id);
    const toolName = firstString(rawCall.toolName, rawCall.name, rawFunction.name);

    if (!toolCallId || !toolName) {
      continue;
    }

    parts.push({
      type: "tool-call",
      toolCallId,
      toolName,
      input: parseToolCallInput(rawCall, rawFunction),
    });
  }

  return parts;
}

function normalizeToolContent(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message.content)) {
    return message.content;
  }

  const toolCallId = firstString(message.toolCallId, message.id) ?? "tool-call";
  const toolName = firstString(message.toolName, message.name) ?? "tool";
  const parsed = parseJsonIfPossible(message.content);

  return [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output:
        typeof parsed === "string"
          ? { type: "text", value: parsed }
          : { type: "json", value: parsed },
    },
  ];
}

function normalizeUserContent(content: unknown): UserContent {
  if (Array.isArray(content)) {
    return content as UserContent;
  }
  return stringifyMessageContent(content);
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

function parseToolCallInput(
  rawCall: Record<string, unknown>,
  rawFunction: Record<string, unknown>
): unknown {
  if ("input" in rawCall) {
    return rawCall.input;
  }
  return parseJsonIfPossible(rawCall.arguments ?? rawFunction.arguments ?? {});
}

function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? "";
  }
  try {
    return JSON.parse(value);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — tool-call `arguments` may be a
    // plain (non-JSON) string; returning the raw value is the correct parse of a
    // non-JSON argument, not a swallowed failure.
    return value;
  }
}

function parseRecordArgPath(path: string): string[] {
  if (path === "$") return [];
  if (!path.startsWith("$.")) return [];
  return path.slice(2).split(".");
}

function restoreStrictSafeRecordValue(value: unknown, transform: RecordArgTransform): unknown {
  const record = asOptionalRecord(value);
  if (!record) return value;
  const entries = record[transform.entriesKey];
  if (!Array.isArray(entries)) return value;

  const restored: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key !== transform.entriesKey) {
      restored[key] = nested;
    }
  }

  for (const entry of entries) {
    const row = asOptionalRecord(entry);
    if (!row) continue;
    const key = typeof row.key === "string" ? row.key : undefined;
    if (!key) continue;
    const rawValue = row.value;
    restored[key] =
      transform.valueMode === "json-string" && typeof rawValue === "string"
        ? parseJsonIfPossible(rawValue)
        : rawValue;
  }

  return restored;
}

function restoreRecordArgAtPath(
  value: unknown,
  tokens: string[],
  transform: RecordArgTransform
): unknown {
  if (tokens.length === 0) {
    return restoreStrictSafeRecordValue(value, transform);
  }

  const [token, ...rest] = tokens;
  if (token === "items" && Array.isArray(value)) {
    return value.map((item) => restoreRecordArgAtPath(item, rest, transform));
  }
  if (/^items\[\d+\]$/.test(token)) {
    return Array.isArray(value)
      ? value.map((item) => restoreRecordArgAtPath(item, rest, transform))
      : value;
  }

  const record = asOptionalRecord(value);
  if (!record || !(token in record)) {
    return value;
  }
  return {
    ...record,
    [token]: restoreRecordArgAtPath(record[token], rest, transform),
  };
}

function restoreRecordArgInput(input: unknown, transforms: RecordArgTransform[]): unknown {
  return [...transforms]
    .sort((a, b) => parseRecordArgPath(a.path).length - parseRecordArgPath(b.path).length)
    .reduce(
      (current, transform) =>
        restoreRecordArgAtPath(current, parseRecordArgPath(transform.path), transform),
      input
    );
}

function restoreRecordArgToolCalls(
  toolCalls: unknown,
  transformsByTool: Record<string, RecordArgTransform[]>
): unknown[] | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.map((toolCall) => {
    const call = asOptionalRecord(toolCall);
    if (!call) return toolCall;
    const rawFunction = asRecord(call.function);
    const toolName = firstString(call.toolName, call.name, rawFunction.name);
    const transforms = toolName ? transformsByTool[toolName] : undefined;
    if (!transforms?.length) return toolCall;

    if ("input" in call) {
      return {
        ...call,
        input: restoreRecordArgInput(call.input, transforms),
      };
    }

    if (typeof call.arguments === "string") {
      const parsed = parseJsonIfPossible(call.arguments);
      return {
        ...call,
        arguments: JSON.stringify(restoreRecordArgInput(parsed, transforms)),
      };
    }

    if (typeof rawFunction.arguments === "string") {
      const parsed = parseJsonIfPossible(rawFunction.arguments);
      return {
        ...call,
        function: {
          ...rawFunction,
          arguments: JSON.stringify(restoreRecordArgInput(parsed, transforms)),
        },
      };
    }

    return toolCall;
  });
}

function normalizeToolChoice(toolChoice: unknown): ToolChoice<ToolSet> | undefined {
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
  if (choice.type === "tool") {
    if (typeof choice.toolName === "string" && choice.toolName.length > 0) {
      return toolChoice as ToolChoice<ToolSet>;
    }
    const toolName = firstString(choice.toolName, choice.name);
    if (toolName) {
      return { type: "tool", toolName };
    }
  }

  if (choice.type === "function") {
    const fn = asRecord(choice.function);
    const toolName = firstString(fn.name);
    if (toolName) {
      return { type: "tool", toolName };
    }
  }

  const namedTool = firstString(choice.name);
  if (namedTool) {
    return { type: "tool", toolName: namedTool };
  }

  return toolChoice as ToolChoice<ToolSet>;
}

function hasIllegalStrictRoot(node: Record<string, unknown>): boolean {
  // Strict-mode JSON schema validators on OpenAI-compatible providers (Groq,
  // Cerebras, OpenAI strict tools) reject tool-parameters whose top level is
  // not `type: "object"` or carries `oneOf`/`anyOf`/`enum`/`not` at the root.
  // The error wording varies by provider but the constraint is uniform.
  if (node.type !== "object") return true;
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) return true;
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) return true;
  if (Array.isArray(node.enum)) return true;
  if (node.not !== undefined) return true;
  return false;
}

// Constraint keywords that strict-grammar providers reject with a hard 400
// that fails the ENTIRE request. The exact set was bisected live against
// api.elizacloud.ai / gpt-oss-120b (Cerebras): maxItems/minItems/maxLength/
// minLength/pattern/format/min-maxProperties are rejected; numeric bounds
// (minimum/maximum/multipleOf) and uniqueItems are accepted, so they are NOT
// stripped. Each maps to a human phrase folded into `description` so the model
// still sees the intent after the machine-readable keyword is removed.
const STRICT_UNSUPPORTED_CONSTRAINTS: Record<string, (value: unknown) => string> = {
  maxItems: (v) => `at most ${v} items`,
  minItems: (v) => `at least ${v} items`,
  maxLength: (v) => `at most ${v} characters`,
  minLength: (v) => `at least ${v} characters`,
  pattern: (v) => `matching the pattern ${v}`,
  format: (v) => `in ${v} format`,
  minProperties: (v) => `at least ${v} properties`,
  maxProperties: (v) => `at most ${v} properties`,
};

/**
 * Removes constraint keywords that strict-grammar providers reject, folding
 * each into the node's `description` so the model keeps the guidance. Mutates
 * the passed (already-shallow-copied) node in place.
 *
 * Removing them from the wire is lossless for correctness: `parseAndValidate`
 * (runtime/validated-model-call.ts) re-checks the caller's ORIGINAL schema
 * app-side, so any real bound is still enforced on the returned value.
 */
function stripStrictUnsupportedConstraints(node: Record<string, unknown>): void {
  const hints: string[] = [];
  for (const [keyword, phrase] of Object.entries(STRICT_UNSUPPORTED_CONSTRAINTS)) {
    if (keyword in node) {
      hints.push(phrase(node[keyword]));
      delete node[keyword];
    }
  }
  if (hints.length === 0) return;
  const existing = typeof node.description === "string" ? node.description.trim() : "";
  const suffix = `(${hints.join(", ")})`;
  node.description = existing ? `${existing} ${suffix}` : suffix;
}

/**
 * Human phrase describing a DECLARED free-form/open map so the intent survives
 * when we close the object on the wire. Returns `null` for an undeclared
 * (`undefined`) additionalProperties — that is a plain object, not a data-loss
 * case. `true` → open map of any value; a schema value → open map of that type.
 */
function additionalPropertiesHint(additionalProperties: unknown): string | null {
  if (additionalProperties === true) {
    return "also accepts arbitrary additional properties as key/value pairs";
  }
  if (
    additionalProperties &&
    typeof additionalProperties === "object" &&
    !Array.isArray(additionalProperties)
  ) {
    const valueType = (additionalProperties as Record<string, unknown>).type;
    const typeStr = typeof valueType === "string" ? `${valueType} ` : "";
    return `also accepts arbitrary additional ${typeStr}values as key/value pairs`;
  }
  return null;
}

const STRICT_SAFE_RECORD_ENTRIES_KEY = "__eliza_record_entries";

function chooseRecordEntriesKey(properties: Record<string, unknown>): string {
  if (!(STRICT_SAFE_RECORD_ENTRIES_KEY in properties)) {
    return STRICT_SAFE_RECORD_ENTRIES_KEY;
  }
  let index = 2;
  while (`${STRICT_SAFE_RECORD_ENTRIES_KEY}_${index}` in properties) {
    index++;
  }
  return `${STRICT_SAFE_RECORD_ENTRIES_KEY}_${index}`;
}

function strictSafeRecordValueSchema(additionalProperties: unknown): {
  schema: JSONSchema7;
  mode: RecordArgValueMode;
} {
  if (additionalProperties === true) {
    return {
      mode: "json-string",
      schema: {
        type: "string",
        description:
          "JSON-encoded value for this arbitrary key. Use plain text for string values and JSON text for objects, arrays, numbers, booleans, or null.",
      },
    };
  }
  return {
    mode: "schema",
    schema: sanitizeJsonSchema(additionalProperties),
  };
}

function strictSafeRecordEntriesSchema(valueSchema: JSONSchema7): JSONSchema7 {
  return {
    type: "array",
    description:
      "Additional arbitrary key/value entries for this record/map. Each entry becomes a property on the original tool argument object before validation.",
    items: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Property key to add to the original record/map argument.",
        },
        value: valueSchema,
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  };
}

/**
 * @param path - dotted location threaded through recursion for reverse-mapping
 *   returned tool-call args.
 */
function sanitizeJsonSchema(
  schema: unknown,
  isRoot = false,
  path = "$",
  transforms?: RecordArgTransform[]
): JSONSchema7 {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    // Permissive fallback: no `properties: {}`/`additionalProperties: false`
    // pair, which strict-grammar providers reject. See `normalizeSchemaForCerebras`
    // in @elizaos/core for the rationale.
    return { type: "object" };
  }

  const record = schema as Record<string, unknown>;
  let sanitized: Record<string, unknown> = { ...record };

  // This is the single wire choke point — every response_format schema
  // (buildStructuredOutput) and every tool schema (normalizeNativeTools)
  // funnels through here, so strip the strict-unsupported constraint keywords
  // centrally instead of relying on each schema author to remember the rule.
  // UNCONDITIONAL, not Cerebras-gated: isCerebrasMode is proxy-blind — an agent
  // pointed at api.elizacloud.ai with OPENAI_API_KEY looks like plain OpenAI,
  // which is exactly the deployment where the 400 fired (#11123/#11141). The
  // recursion below reaches nested nodes via properties/items/unions.
  stripStrictUnsupportedConstraints(sanitized);

  if (typeof sanitized.type !== "string") {
    const inferredType = inferJsonSchemaType(sanitized, isRoot);
    if (inferredType) {
      sanitized.type = inferredType;
    }
  }

  if (isRoot && hasIllegalStrictRoot(sanitized)) {
    // Wrap the original schema under properties.value. Strict-tool callers
    // that unwrap arguments will see `{ value: <original> }`. The recursion
    // below normalises the wrapped child like any other property.
    sanitized = {
      type: "object",
      properties: { value: { ...record } },
      required: ["value"],
      additionalProperties: false,
    };
  }

  if (
    sanitized.properties &&
    typeof sanitized.properties === "object" &&
    !Array.isArray(sanitized.properties)
  ) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized.properties as Record<string, unknown>)) {
      properties[key] = sanitizeJsonSchema(value, false, `${path}.${key}`, transforms);
    }
    sanitized.properties = properties;

    const propertyKeys = Object.keys(properties);
    const existingRequired = Array.isArray(sanitized.required)
      ? sanitized.required.filter((key): key is string => typeof key === "string")
      : [];
    sanitized.required = [...new Set([...existingRequired, ...propertyKeys])];
  }

  if (sanitized.type === "object" && sanitized.additionalProperties !== false) {
    // Strict-grammar providers reject open maps (schema-valued or `true`
    // additionalProperties) with a hard 400, and provider strictness is
    // proxy-blind (an agent on api.elizacloud.ai with OPENAI_API_KEY may still
    // route to strict Cerebras — #11123/#11156), so we must always close the
    // object on the wire. But a DECLARED free-form map (e.g. contact
    // customFields = `additionalProperties: { type: "string" }`) was collapsed
    // SILENTLY: the model saw a closed object, could emit no keys, and the arg
    // always arrived empty (#11249). Fold the intent into `description`
    // (mirroring stripStrictUnsupportedConstraints) so it is preserved —
    // non-strict providers can still emit the pairs (app-side parseAndValidate
    // re-checks the caller's ORIGINAL schema and accepts them), and strict
    // providers surface the intent instead of losing it without a trace.
    const hint = additionalPropertiesHint(sanitized.additionalProperties);
    if (hint && transforms) {
      const properties =
        sanitized.properties &&
        typeof sanitized.properties === "object" &&
        !Array.isArray(sanitized.properties)
          ? ({ ...(sanitized.properties as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      const entriesKey = chooseRecordEntriesKey(properties);
      const { schema: valueSchema, mode } = strictSafeRecordValueSchema(
        sanitized.additionalProperties
      );
      properties[entriesKey] = strictSafeRecordEntriesSchema(valueSchema);
      sanitized.properties = properties;
      sanitized.required = [
        ...new Set([
          ...(Array.isArray(sanitized.required)
            ? sanitized.required.filter((key): key is string => typeof key === "string")
            : []),
          ...Object.keys(properties),
        ]),
      ];
      transforms.push({ path, entriesKey, valueMode: mode });
      const existing =
        typeof sanitized.description === "string" ? sanitized.description.trim() : "";
      const suffix = `${hint}; provide arbitrary entries in ${entriesKey} as key/value pairs`;
      sanitized.description = existing ? `${existing} (${suffix})` : `(${suffix})`;
    } else if (hint) {
      // response_format schemas have no returned tool args to reverse-map, so
      // they keep the old strict-safe close-and-describe behavior.
    }
    sanitized.additionalProperties = false;
    if (hint && !transforms) {
      const existing =
        typeof sanitized.description === "string" ? sanitized.description.trim() : "";
      sanitized.description = existing ? `${existing} (${hint})` : `(${hint})`;
    }
  }

  if (sanitized.items) {
    sanitized.items = Array.isArray(sanitized.items)
      ? sanitized.items.map((item, i) =>
          sanitizeJsonSchema(item, false, `${path}.items[${i}]`, transforms)
        )
      : sanitizeJsonSchema(sanitized.items, false, `${path}.items`, transforms);
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    const value = sanitized[unionKey];
    if (Array.isArray(value)) {
      sanitized[unionKey] = value.map((item, i) =>
        sanitizeJsonSchema(item, false, `${path}.${unionKey}[${i}]`, transforms)
      );
    }
  }

  // Every other schema-bearing keyword must be walked too, or a stripped
  // keyword nested inside one survives to the wire. `$defs`/`definitions`
  // matter most in practice: zod's `toJSONSchema` hoists reused/nullable
  // sub-schemas into `$defs`, so a `.max()`/`.regex()` on a shared field would
  // otherwise slip through the strip. `contains`/`propertyNames`/`not`/`if`/
  // `then`/`else` take a single sub-schema; `patternProperties`/`$defs`/
  // `definitions` are maps of them.
  for (const singleKey of ["contains", "propertyNames", "not", "if", "then", "else"] as const) {
    const value = sanitized[singleKey];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[singleKey] = sanitizeJsonSchema(value, false, `${path}.${singleKey}`, transforms);
    }
  }
  for (const mapKey of ["patternProperties", "$defs", "definitions"] as const) {
    const value = sanitized[mapKey];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const walked: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
        walked[key] = sanitizeJsonSchema(sub, false, `${path}.${mapKey}.${key}`, transforms);
      }
      sanitized[mapKey] = walked;
    }
  }

  return sanitized as JSONSchema7;
}

function inferJsonSchemaType(schema: Record<string, unknown>, isRoot: boolean): string | undefined {
  if (
    "properties" in schema ||
    "required" in schema ||
    "additionalProperties" in schema ||
    isRoot
  ) {
    return "object";
  }
  if ("items" in schema) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = new Set(schema.enum.map((value) => typeof value));
    if (types.size === 1) {
      const [type] = [...types];
      if (type === "string" || type === "number" || type === "boolean") {
        return type;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function usesNativeTextResult(params: GenerateTextParamsWithOpenAIOptions): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

function buildNativeTextResult(
  result: {
    text: string;
    toolCalls?: unknown[];
    finishReason?: string;
    usage?: LanguageModelUsage;
    providerMetadata?: unknown;
  },
  modelName?: string
): NativeGenerateTextResult {
  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    usage: convertUsage(result.usage),
    providerMetadata: mergeProviderModelName(result.providerMetadata, modelName),
  };
}

function handledPromise<T>(value: T | PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(value);
  promise.catch(() => {
    // error-policy:J5 unhandled-rejection suppression — the streaming path
    // primarily consumes `textStream`. AI SDK companion promises such as `text`
    // can reject later on empty streams even when no caller requested them; the
    // real error is still observed by whoever awaits `textStream`.
  });
  return promise;
}

function handledMappedPromise<T, U>(
  value: T | PromiseLike<T>,
  mapper: (resolved: T) => U | PromiseLike<U>
): Promise<U> {
  return handledPromise(handledPromise(value).then(mapper));
}

function mergeProviderModelName(providerMetadata: unknown, modelName?: string): unknown {
  if (!modelName) {
    return providerMetadata;
  }
  if (
    providerMetadata &&
    typeof providerMetadata === "object" &&
    !Array.isArray(providerMetadata)
  ) {
    return {
      ...(providerMetadata as Record<string, unknown>),
      modelName,
    };
  }
  return { modelName };
}

function createLlmCallDetails(
  modelName: string,
  params: GenerateTextParams,
  systemPrompt: string | undefined,
  actionType: string,
  modelType?: ModelTypeName,
  providerOptions?: Record<string, unknown>,
  generateParams?: NativeTextParams
): RecordLlmCallDetails {
  const originalParams = params as GenerateTextParamsWithOpenAIOptions;
  const nativeParams = generateParams as
    | (NativeTextParams & {
        output?: unknown;
        maxOutputTokens?: unknown;
      })
    | undefined;
  const nativePrompt = nativeParams && "prompt" in nativeParams ? nativeParams.prompt : undefined;
  const nativeMessages =
    nativeParams && "messages" in nativeParams && Array.isArray(nativeParams.messages)
      ? nativeParams.messages
      : undefined;
  const nativeSystem =
    typeof nativeParams?.system === "string" ? nativeParams.system : systemPrompt;
  return {
    model: modelName,
    modelType,
    provider: "vercel-ai-sdk",
    systemPrompt: nativeSystem ?? "",
    userPrompt:
      typeof nativePrompt === "string"
        ? nativePrompt
        : typeof params.prompt === "string"
          ? params.prompt
          : "",
    prompt: typeof nativePrompt === "string" ? nativePrompt : undefined,
    messages: nativeMessages,
    tools: nativeParams?.tools ?? originalParams.tools,
    toolChoice: nativeParams?.toolChoice ?? originalParams.toolChoice,
    output:
      nativeParams?.output !== undefined
        ? buildTrajectoryOutputDescriptor(originalParams.responseSchema, nativeParams.output)
        : undefined,
    responseSchema: originalParams.responseSchema,
    providerOptions:
      providerOptions ?? nativeParams?.providerOptions ?? originalParams.providerOptions,
    temperature: params.temperature ?? 0,
    maxTokens:
      typeof nativeParams?.maxOutputTokens === "number"
        ? nativeParams.maxOutputTokens
        : params.omitMaxTokens
          ? 0
          : (params.maxTokens ?? 8192),
    maxTokensOmitted:
      params.omitMaxTokens && typeof nativeParams?.maxOutputTokens !== "number" ? true : undefined,
    purpose: "external_llm",
    actionType,
  };
}

function buildTrajectoryOutputDescriptor(responseSchema: unknown, output: unknown): unknown {
  if (responseSchema !== undefined) {
    return {
      type: "object",
      schema: responseSchema,
    };
  }
  return toTrajectoryJsonSafe(output);
}

function toTrajectoryJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested === "function") return undefined;
        if (typeof nested === "bigint") return nested.toString();
        return nested;
      })
    ) as unknown;
  } catch {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — trajectory JSON
    // serialization is a telemetry artifact; on a non-serializable value fall
    // back to a string repr rather than failing the model call being logged.
    return String(value);
  }
}

function applyUsageToDetails(
  details: RecordLlmCallDetails,
  usage: LanguageModelUsage | undefined
): void {
  if (!usage) {
    return;
  }
  details.promptTokens = usage.inputTokens ?? 0;
  details.completionTokens = usage.outputTokens ?? 0;
}

// ============================================================================
// Core Generation Function
// ============================================================================

/**
 * Whether a thrown model-call error is a transient provider hiccup that is
 * worth retrying. The AI SDK already retries clear-cut retryables (408/409/429/
 * 5xx) via its own `maxRetries`, but Cerebras under load returns its transient
 * "Encountered a server error, please try again" as an HTTP **400**, which the
 * SDK classifies as non-retryable and surfaces immediately — failing a coding
 * build that the very same request would complete on a second attempt (observed
 * live: large multi-tool requests 400 intermittently under fleet load, succeed
 * on retry). We treat such a 400 as transient ONLY when its body/message looks
 * like an overload, never when it looks like a genuine validation error, so we
 * don't mask real malformed-request bugs.
 */
function isTransientProviderError(error: unknown): boolean {
  const e = error as
    | { statusCode?: number; status?: number; message?: string; data?: unknown }
    | undefined;
  if (!e) return false;
  const status = e.statusCode ?? e.status;
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  const msg = `${e.message ?? ""} ${JSON.stringify(e.data ?? "")} ${
    (e as { type?: string }).type ?? ""
  }`.toLowerCase();
  // No HTTP status: either a network-level failure OR a provider that returns
  // its transient error as a bare object (Cerebras passes
  // `{message:"Encountered a server error, please try again", type:"server_error"}`
  // straight to the AI SDK's onError with no statusCode). Retry both — but never
  // a genuine validation error that merely lacks a status.
  if (status === undefined) {
    if (/invalid|unsupported|must be|required field|malformed|not allowed|json schema/.test(msg)) {
      return false;
    }
    return /timeout|timed out|econnreset|econnrefused|socket|network|fetch failed|terminated|server error|server_error|try again|overload|capacity|temporarily|unavailable|busy|rate ?limit|please retry/.test(
      msg
    );
  }
  // Transient 400: overload/server-error wording. Do NOT retry genuine
  // validation failures (invalid/unsupported/schema/required/malformed).
  if (status === 400) {
    if (/invalid|unsupported|must be|required|malformed|not allowed|schema/.test(msg)) {
      return false;
    }
    return /server error|try again|overload|capacity|temporarily|busy|rate/.test(msg);
  }
  return false;
}

/**
 * Call `generateText` with bounded retry + exponential backoff on transient
 * provider errors (see {@link isTransientProviderError}). Mirrors opencode's
 * resilience posture (it sets `retries: 2` on its coding LLM call) but also
 * covers Cerebras's non-standard transient-400 that the AI SDK won't retry.
 * Non-transient errors propagate immediately on the first attempt.
 */
async function generateTextWithTransientRetry(
  generateParams: NativeGenerateTextParams,
  maxRetries = 3
): Promise<Awaited<ReturnType<typeof generateText<ToolSet>>>> {
  let attempt = 0;
  for (;;) {
    try {
      return (await generateText(
        generateParams as Parameters<typeof generateText>[0]
        // biome-ignore lint/suspicious/noExplicitAny: see above.
      )) as any;
    } catch (error) {
      // error-policy:J2 context-adding rethrow — terminal or retry-exhausted
      // errors rethrow unchanged; only bounded transient provider errors retry.
      if (attempt >= maxRetries || !isTransientProviderError(error)) throw error;
      attempt++;
      const backoffMs = Math.min(3000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
      logger.warn(
        `[OpenAI] transient model error (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms: ${
          (error as { message?: string })?.message ?? String(error)
        }`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

interface BufferedStreamResult {
  text: string;
  toolCalls: Awaited<ReturnType<typeof streamText<ToolSet>>["toolCalls"]> | undefined;
  usage: LanguageModelUsage | undefined;
  finishReason: string | undefined;
}

/**
 * Consume a `streamText` call to completion with bounded transient-error retry.
 *
 * Coding/structured planner calls stream, but Cerebras under fleet load returns
 * intermittent transient 400s on large multi-tool requests — and for a stream
 * that error surfaces only while the stream is *consumed*, so the AI SDK's
 * `maxRetries` (which also won't retry a 400) never helps and the build fails on
 * an error the very same request would survive on a second attempt. We buffer
 * the stream and re-issue the whole call on a transient failure. Token streaming
 * is not user-visible for coding (the sub-agent relays a final summary), so
 * buffering loses nothing there. Used only in coding mode; chat keeps live
 * streaming.
 */
async function consumeStreamWithTransientRetry(
  generateParams: NativeGenerateTextParams,
  onChunk: ((chunk: string) => void) | undefined,
  maxRetries = 5
): Promise<BufferedStreamResult> {
  let attempt = 0;
  for (;;) {
    try {
      // The AI SDK does NOT throw on a request failure during streaming — it
      // routes the error to `onError` and ends the stream empty (an empty
      // result then reads as "model called no tool" upstream). Capture it here
      // and rethrow after consumption so the retry below can act on it. (This
      // is the same reason opencode attaches an onError to its streamText.)
      let capturedError: unknown;
      const result = streamText({
        ...(generateParams as Parameters<typeof streamText>[0]),
        onError: ({ error }: { error: unknown }) => {
          capturedError = error;
        },
      });
      let text = "";
      for await (const chunk of result.textStream) {
        onChunk?.(chunk);
        text += chunk;
      }
      const toolCalls = await result.toolCalls;
      const usage = await result.usage;
      const finishReason = (await result.finishReason) as string | undefined;
      if (capturedError) throw capturedError;
      return { text, toolCalls, usage, finishReason };
    } catch (error) {
      // error-policy:J2 context-adding rethrow — terminal or retry-exhausted
      // errors rethrow unchanged; only bounded transient provider errors retry.
      if (attempt >= maxRetries || !isTransientProviderError(error)) throw error;
      attempt++;
      const backoffMs = Math.min(3000, 300 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
      logger.warn(
        `[OpenAI] transient stream error (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms: ${
          (error as { message?: string })?.message ?? String(error)
        }`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/**
 * Generates text using the specified model type.
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @param modelType - The type of model (TEXT_SMALL or TEXT_LARGE)
 * @param getModelFn - Function to get the model name
 * @returns Generated text or stream result
 */
async function generateTextByModelType(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName,
  getModelFn: ModelNameGetter
): Promise<string | TextStreamResult> {
  const paramsWithAttachments = params as GenerateTextParamsWithOpenAIOptions;
  const openai = createOpenAIClient(runtime);
  const modelName = resolveRequestedModelName(paramsWithAttachments, runtime, getModelFn);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);
  const providerOptions = resolveProviderOptions(params, runtime, modelName);
  const hasAttachments = (paramsWithAttachments.attachments?.length ?? 0) > 0;
  const userContent = hasAttachments ? buildUserContent(paramsWithAttachments) : undefined;
  const shouldReturnNativeResult = usesNativeTextResult(paramsWithAttachments);

  const systemPrompt = resolveEffectiveSystemPrompt({
    params: paramsWithAttachments,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
  const agentName = paramsWithAttachments.providerOptions?.agentName;
  const telemetryConfig: NativeTelemetrySettings = {
    isEnabled: getExperimentalTelemetry(runtime),
    functionId: agentName ? `agent:${agentName}` : undefined,
    metadata: agentName ? { agentName } : undefined,
  };

  // Chat Completions is the default: broadest compatibility, and it works
  // against every OpenAI-compatible endpoint (Cerebras, local servers, proxies).
  // gpt-5 / gpt-5-mini reasoning models ignore temperature/penalty/stop params.
  //
  const model = openai.chat(modelName);
  const cerebrasMode = isCerebrasMode(runtime);
  const normalizedToolResult = normalizeNativeToolsForCall(paramsWithAttachments.tools, {
    cerebrasMode,
  });
  const normalizedTools = normalizedToolResult.tools;
  const normalizedToolChoice = normalizeToolChoice(paramsWithAttachments.toolChoice);
  const normalizedMessages = normalizeNativeMessages(paramsWithAttachments.messages);
  const wireMessages = dropDuplicateLeadingSystemMessage(normalizedMessages, systemPrompt);
  const effectiveMessages =
    wireMessages && wireMessages.length > 0 ? wireMessages : normalizedMessages;
  const promptText =
    typeof params.prompt === "string" && params.prompt.length > 0 ? params.prompt : "";
  const promptOrMessages: NativePrompt =
    effectiveMessages && effectiveMessages.length > 0
      ? { messages: effectiveMessages }
      : userContent
        ? { messages: [{ role: "user" as const, content: userContent }] }
        : { prompt: promptText };
  // elizaOS callers pass `responseFormat: { type: "json_object" | "text" }`
  // (see `GenerateTextParams` in @elizaos/core). The AI SDK's equivalent
  // is `responseFormat: { type: "json" }` (which translates to
  // `response_format: { type: "json_object" }` at the OpenAI wire layer).
  // Translate the shape so the param actually reaches the API call —
  // before this, callers asking for json_object were silently ignored
  // and Cerebras returned plain text, dropping us into the simple-reply
  // fallback every turn.
  const callerResponseFormat = (paramsWithAttachments as { responseFormat?: unknown })
    .responseFormat;
  const responseFormatType =
    typeof callerResponseFormat === "string"
      ? callerResponseFormat
      : callerResponseFormat &&
          typeof callerResponseFormat === "object" &&
          "type" in callerResponseFormat
        ? (callerResponseFormat as { type: string }).type
        : undefined;
  const wireResponseFormat: { type: "json" } | { type: "text" } | undefined =
    responseFormatType === "json_object"
      ? { type: "json" }
      : responseFormatType === "text"
        ? { type: "text" }
        : undefined;

  const generateParams: NativeTextParams = {
    model,
    ...promptOrMessages,
    system: systemPrompt,
    allowSystemInMessages: true,
    // Omit the cap when the caller opted out (direct-channel Stage-1) so the
    // model's own max applies — a hardcoded value 400s when it exceeds the
    // model's limit. Other callers keep the 8192 default.
    ...(params.omitMaxTokens ? {} : { maxOutputTokens: params.maxTokens ?? 8192 }),
    experimental_telemetry: telemetryConfig,
    ...(normalizedTools ? { tools: normalizedTools } : {}),
    ...(normalizedToolChoice ? { toolChoice: normalizedToolChoice } : {}),
    // Cerebras's OpenAI-compatible endpoint does not accept the
    // `response_format: { type: "json_schema", ... }` payload that the AI SDK
    // emits when `output: Output.object(...)` is set. Fall back to relying on
    // `responseFormat: { type: "json_object" }` (already passed by callers)
    // plus the schema embedded in the prompt body.
    ...(paramsWithAttachments.responseSchema && !isCerebrasMode(runtime)
      ? { output: buildStructuredOutput(paramsWithAttachments.responseSchema) }
      : {}),
    ...(wireResponseFormat ? { responseFormat: wireResponseFormat } : {}),
    ...(providerOptions ? { providerOptions: providerOptions as NativeProviderOptions } : {}),
  };

  // Handle streaming mode
  if (params.stream) {
    // Coding/structured planner calls prioritise reliability over live token
    // streaming: buffer the stream to completion with transient-error retry so a
    // Cerebras-under-load 400 doesn't fail an otherwise-good build (see
    // consumeStreamWithTransientRetry). Token streaming isn't user-visible for
    // coding. Regular chat falls through to the live-streaming path below.
    const fullActionSurface = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE?.trim().toLowerCase();
    if (
      fullActionSurface === "1" ||
      fullActionSurface === "true" ||
      fullActionSurface === "yes" ||
      fullActionSurface === "on"
    ) {
      const details = createLlmCallDetails(
        modelName,
        params,
        systemPrompt,
        "ai.streamText",
        modelType,
        providerOptions,
        generateParams
      );
      details.response = "";
      const buffered = await recordLlmCall(runtime, details, () =>
        consumeStreamWithTransientRetry(generateParams, params.onStreamChunk)
      );
      const restoredToolCalls = restoreRecordArgToolCalls(
        buffered.toolCalls,
        normalizedToolResult.recordArgTransformsByTool
      );
      details.response = buffered.text;
      details.toolCalls = restoredToolCalls;
      details.finishReason = buffered.finishReason;
      if (buffered.usage) {
        applyUsageToDetails(details, buffered.usage);
        emitModelUsageEvent(runtime, modelType, params.prompt ?? "", buffered.usage);
      }
      return {
        textStream: (async function* replayBufferedStream() {
          if (buffered.text) yield buffered.text;
        })(),
        text: Promise.resolve(buffered.text),
        ...(shouldReturnNativeResult ? { toolCalls: Promise.resolve(restoredToolCalls) } : {}),
        usage: Promise.resolve(convertUsage(buffered.usage)),
        finishReason: Promise.resolve(buffered.finishReason),
      };
    }
    const details = createLlmCallDetails(
      modelName,
      params,
      systemPrompt,
      "ai.streamText",
      modelType,
      providerOptions,
      generateParams
    );
    details.response = "";
    assertActiveTrajectoryForLlmCall({
      actionType: details.actionType,
      model: details.model,
      modelType: details.modelType,
      purpose: details.purpose,
    });
    const startedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const responseChunks: string[] = [];
    let capturedStreamError: unknown;
    let companionStreamError: unknown;
    let telemetryFinalized = false;
    const result = await streamText({
      ...generateParams,
      onError: ({ error }: { error: unknown }) => {
        capturedStreamError = error;
      },
    });
    const textPromise = handledPromise(result.text);
    const rawUsagePromise = handledPromise(result.usage);
    const rawFinishReasonPromise = handledPromise(result.finishReason);
    const rawToolCallsPromise = handledPromise(result.toolCalls);
    const restoredToolCallsPromise = handledMappedPromise(rawToolCallsPromise, (toolCalls) =>
      restoreRecordArgToolCalls(toolCalls, normalizedToolResult.recordArgTransformsByTool)
    );
    const usagePromise = handledMappedPromise(rawUsagePromise, convertUsage);
    const finishReasonPromise = handledMappedPromise(
      rawFinishReasonPromise,
      (r) => r as string | undefined
    );
    const finalizeStreamingTelemetry = async () => {
      if (telemetryFinalized) {
        return;
      }
      telemetryFinalized = true;
      const [usageResult, finishReasonResult, toolCallsResult] = await Promise.allSettled([
        rawUsagePromise,
        rawFinishReasonPromise,
        restoredToolCallsPromise,
      ]);

      details.response = responseChunks.join("");
      if (usageResult.status === "fulfilled" && usageResult.value) {
        applyUsageToDetails(details, usageResult.value);
        emitModelUsageEvent(runtime, modelType, params.prompt ?? "", usageResult.value);
      } else if (usageResult.status === "rejected") {
        companionStreamError ??= usageResult.reason;
      }
      if (finishReasonResult.status === "fulfilled") {
        details.finishReason = finishReasonResult.value as string | undefined;
      } else {
        companionStreamError ??= finishReasonResult.reason;
      }
      if (toolCallsResult.status === "fulfilled") {
        details.toolCalls = toolCallsResult.value;
      } else {
        companionStreamError ??= toolCallsResult.reason;
      }

      const elapsed =
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()) - startedAt;
      logActiveTrajectoryLlmCall(runtime, {
        ...details,
        response: details.response,
        latencyMs: Math.max(0, Math.round(elapsed)),
      });
    };

    return {
      textStream: (async function* textStreamWithCallback() {
        let streamIterationError: unknown;
        try {
          for await (const chunk of result.textStream) {
            responseChunks.push(chunk);
            params.onStreamChunk?.(chunk);
            yield chunk;
          }
        } catch (error) {
          // error-policy:J2 context-adding rethrow — capture the stream-iteration
          // error so `finally` can finalize telemetry, then rethrow it below.
          streamIterationError = error;
        } finally {
          await finalizeStreamingTelemetry();
        }
        if (streamIterationError) {
          throw streamIterationError;
        }
        if (capturedStreamError) {
          throw capturedStreamError;
        }
        if (companionStreamError) {
          throw companionStreamError;
        }
      })(),
      text: textPromise,
      ...(shouldReturnNativeResult ? { toolCalls: restoredToolCallsPromise } : {}),
      usage: usagePromise,
      finishReason: finishReasonPromise,
    };
  }

  // Non-streaming mode
  const details = createLlmCallDetails(
    modelName,
    params,
    systemPrompt,
    "ai.generateText",
    modelType,
    providerOptions,
    generateParams
  );
  const result = await recordLlmCall(runtime, details, async () => {
    const result = await generateTextWithTransientRetry(generateParams);
    const restoredToolCalls = restoreRecordArgToolCalls(
      result.toolCalls,
      normalizedToolResult.recordArgTransformsByTool
    );
    details.response = result.text;
    details.toolCalls = restoredToolCalls;
    details.finishReason = result.finishReason as string | undefined;
    details.providerMetadata = result.providerMetadata;
    applyUsageToDetails(details, result.usage);
    return {
      text: result.text,
      toolCalls: restoredToolCalls as typeof result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
      providerMetadata: result.providerMetadata,
    };
  });

  if (result.usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt ?? "", result.usage);
  }

  if (shouldReturnNativeResult) {
    return buildNativeTextResult(result, modelName) as NativeTextModelResult;
  }

  return result.text;
}

// ============================================================================
// Public Handlers
// ============================================================================

/**
 * Handles TEXT_SMALL model requests.
 *
 * Uses the configured small model (default: gpt-5-mini).
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @returns Generated text or stream result
 */
export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ModelType.TEXT_SMALL, getSmallModel);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, TEXT_NANO_MODEL_TYPE, getNanoModel);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, TEXT_MEDIUM_MODEL_TYPE, getMediumModel);
}

/**
 * Handles TEXT_LARGE model requests.
 *
 * Uses the configured large model (default: gpt-5).
 *
 * @param runtime - The agent runtime
 * @param params - Generation parameters
 * @returns Generated text or stream result
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ModelType.TEXT_LARGE, getLargeModel);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, TEXT_MEGA_MODEL_TYPE, getMegaModel);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(
    runtime,
    params,
    RESPONSE_HANDLER_MODEL_TYPE,
    getResponseHandlerModel
  );
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextByModelType(runtime, params, ACTION_PLANNER_MODEL_TYPE, getActionPlannerModel);
}

// ─── Test-only exports ──────────────────────────────────────────────────────
// These are exported for the shape tests in `__tests__/reasoning-effort.shape.test.ts`.
// Not part of the public API; do not import outside tests.

/** @internal — exported for unit tests only. */
export const __INTERNAL_resolveProviderOptions = resolveProviderOptions;
/** @internal — exported for unit tests only. */
export const __INTERNAL_normalizeNativeMessages = normalizeNativeMessages;
/** @internal — exported for unit tests only. */
export const __INTERNAL_stripReasoningParts = stripReasoningParts;
/** @internal — exported for unit tests only. */
export const __INTERNAL_sanitizeJsonSchema = sanitizeJsonSchema;
/** @internal — exported for unit tests only. */
export const __INTERNAL_normalizeNativeTools = normalizeNativeTools;
/** @internal — exported for unit tests only. */
export const __INTERNAL_normalizeNativeToolsForCall = normalizeNativeToolsForCall;
/** @internal — exported for unit tests only. */
export const __INTERNAL_restoreRecordArgToolCalls = restoreRecordArgToolCalls;
