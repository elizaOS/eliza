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
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
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

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

function buildUserContent(params: GenerateTextParamsWithOpenAIOptions): UserContent {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "file";
        data: string | Uint8Array | URL;
        mediaType: string;
        filename?: string;
      }
  > = [{ type: "text", text: params.prompt }];

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
 * `gpt-oss-*`, `deepseek-r1`, `qwen-3-thinking`, etc.) — including
 * Cerebras and OpenRouter, which honor the same field. `"low"` keeps
 * reasoning short enough that visible content always fits inside
 * `max_tokens`, which is the failure mode on Cerebras gpt-oss-120b when
 * left unset.
 *
 * Returns `undefined` when the setting is unset or invalid, so non-
 * reasoning models pay no overhead and the wire stays clean.
 *
 * Valid values follow the OpenAI spec exactly: `minimal`, `low`,
 * `medium`, `high`. Anything else is logged and ignored.
 */
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

function resolveReasoningEffort(runtime: IAgentRuntime): ReasoningEffort | undefined {
  const raw = runtime.getSetting("OPENAI_REASONING_EFFORT");
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if ((VALID_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningEffort;
  }
  logger.warn(
    `[OpenAI] OPENAI_REASONING_EFFORT=${raw} is not a valid reasoning effort; ignoring. Expected one of: ${VALID_REASONING_EFFORTS.join(", ")}.`
  );
  return undefined;
}

function resolveProviderOptions(
  params: GenerateTextParams,
  runtime: IAgentRuntime
): Record<string, unknown> | undefined {
  const withOpenAIOptions = params as GenerateTextParamsWithOpenAIOptions;
  const rawProviderOptions = withOpenAIOptions.providerOptions;
  const promptCacheOptions = resolvePromptCacheOptions(params);
  const reasoningEffortFromEnv = resolveReasoningEffort(runtime);

  if (
    !rawProviderOptions &&
    !promptCacheOptions.promptCacheKey &&
    !promptCacheOptions.promptCacheRetention &&
    !reasoningEffortFromEnv
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
    // The caller's explicit `reasoningEffort` wins over the env-var default
    // — this matches the precedence pattern used for promptCacheKey above.
    ...((sanitizedRawOpenAIOptions as { reasoningEffort?: unknown } | undefined)
      ?.reasoningEffort === undefined && reasoningEffortFromEnv
      ? { reasoningEffort: reasoningEffortFromEnv }
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

function normalizeNativeTools(
  tools: unknown,
  options: { cerebrasMode?: boolean } = {}
): ToolSet | undefined {
  if (!tools) {
    return undefined;
  }

  // Existing AI SDK callers already pass a ToolSet keyed by tool name. Keep it
  // intact so custom tool instances, execute hooks, and dynamic tool metadata
  // are preserved.
  if (!Array.isArray(tools)) {
    return tools as ToolSet;
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
    let inputSchema = sanitizeJsonSchema(rawSchema, true);
    if (options.cerebrasMode) {
      // User-supplied schemas may still contain empty-properties subobjects
      // even after sanitizeJsonSchema. Apply Cerebras-specific normalization
      // recursively so deep schemas are accepted by the grammar compiler.
      inputSchema = normalizeSchemaForCerebras(inputSchema) as JSONSchema7;
    }

    // Cerebras's grammar compiler rejects function names containing characters
    // outside `[a-zA-Z0-9_-]` (e.g. `math.factorial`). The AI SDK looks up
    // tools by the registered key, so we register under the sanitized name AND
    // surface it to the model under that name. Tool calls come back with the
    // sanitized name, which the runtime resolves through its action registry —
    // any caller relying on dotted action names should pre-sanitize.
    const registeredName = options.cerebrasMode ? sanitizeFunctionNameForCerebras(name) : name;

    toolSet[registeredName] = {
      ...(description ? { description } : {}),
      inputSchema: jsonSchema(inputSchema as JSONSchema7),
    };
  }

  return Object.keys(toolSet).length > 0 ? (toolSet as ToolSet) : undefined;
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
 * DeepSeek R1, Qwen-3-thinking, etc.) return reasoning in the assistant
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
    return value;
  }
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

function sanitizeJsonSchema(schema: unknown, isRoot = false): JSONSchema7 {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    // Permissive fallback: no `properties: {}`/`additionalProperties: false`
    // pair, which strict-grammar providers reject. See `normalizeSchemaForCerebras`
    // in @elizaos/core for the rationale.
    return { type: "object" };
  }

  const record = schema as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...record };

  if (typeof sanitized.type !== "string") {
    const inferredType = inferJsonSchemaType(sanitized, isRoot);
    if (inferredType) {
      sanitized.type = inferredType;
    }
  }

  if (
    sanitized.properties &&
    typeof sanitized.properties === "object" &&
    !Array.isArray(sanitized.properties)
  ) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized.properties as Record<string, unknown>)) {
      properties[key] = sanitizeJsonSchema(value);
    }
    sanitized.properties = properties;

    const propertyKeys = Object.keys(properties);
    const existingRequired = Array.isArray(sanitized.required)
      ? sanitized.required.filter((key): key is string => typeof key === "string")
      : [];
    sanitized.required = [...new Set([...existingRequired, ...propertyKeys])];
  }

  if (sanitized.type === "object" && sanitized.additionalProperties !== false) {
    sanitized.additionalProperties = false;
  }

  if (sanitized.items) {
    sanitized.items = Array.isArray(sanitized.items)
      ? sanitized.items.map((item) => sanitizeJsonSchema(item))
      : sanitizeJsonSchema(sanitized.items);
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    const value = sanitized[unionKey];
    if (Array.isArray(value)) {
      sanitized[unionKey] = value.map((item) => sanitizeJsonSchema(item));
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
        : (params.maxTokens ?? 8192),
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
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);
  const providerOptions = resolveProviderOptions(params, runtime);
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

  // Use chat() instead of languageModel() to use the Chat Completions API
  // which has better compatibility than the Responses API
  // gpt-5 and gpt-5-mini (reasoning models) don't support temperature,
  // frequencyPenalty, presencePenalty, or stop parameters - use defaults only
  const model = openai.chat(modelName);
  const cerebrasMode = isCerebrasMode(runtime);
  const normalizedTools = normalizeNativeTools(paramsWithAttachments.tools, {
    cerebrasMode,
  });
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
  const generateParams: NativeTextParams = {
    model,
    ...promptOrMessages,
    system: systemPrompt,
    allowSystemInMessages: true,
    maxOutputTokens: params.maxTokens ?? 8192,
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
    ...(providerOptions ? { providerOptions: providerOptions as NativeProviderOptions } : {}),
  };

  // Handle streaming mode
  if (params.stream) {
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
    const result = await recordLlmCall(runtime, details, () => streamText(generateParams));

    return {
      textStream: result.textStream,
      text: Promise.resolve(result.text),
      ...(shouldReturnNativeResult ? { toolCalls: Promise.resolve(result.toolCalls) } : {}),
      usage: Promise.resolve(result.usage).then(convertUsage),
      finishReason: Promise.resolve(result.finishReason).then((r) => r as string | undefined),
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
    const result = await generateText(generateParams);
    details.response = result.text;
    details.toolCalls = result.toolCalls ?? [];
    details.finishReason = result.finishReason as string | undefined;
    details.providerMetadata = result.providerMetadata;
    applyUsageToDetails(details, result.usage);
    return result;
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
