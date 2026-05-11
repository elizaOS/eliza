/**
 * LM Studio text generation for ElizaOS.
 *
 * ## Why this module looks like Ollama's, not OpenAI's
 *
 * LM Studio is an OpenAI-compatible local server, so the bytes-on-the-wire are very
 * similar to `plugin-openai`. But the orchestration concerns are closer to
 * `plugin-ollama`:
 *
 * - Models are picked up from what the user has loaded locally — there is no canonical
 *   "gpt-4o-class" identifier. Callers either override per-tier env vars
 *   (`LMSTUDIO_SMALL_MODEL`, `LMSTUDIO_LARGE_MODEL`) or we fall back to the first id
 *   returned by `GET /v1/models`.
 * - There's no need for the OpenAI plugin's Cerebras / reasoning / image branches.
 *
 * So we mirror Ollama's structure (single `handleTextWithModelType`, structured-output
 * via `Output.object`, optional streaming) but build on `@ai-sdk/openai-compatible`
 * instead of `ollama-ai-provider-v2`.
 *
 * ## Errors
 *
 * `AI_SDK` errors carry `responseBody` / `statusCode` / `url`. `summarizeAiSdkError`
 * surfaces these so operators get LM Studio's actual response body in logs instead
 * of a generic "Internal Server Error" — local servers commonly fail with "no model
 * loaded" or OOM, both of which are only visible in the body.
 */

import type {
  GenerateTextParams,
  GenerateTextResult,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
  TokenUsage,
  ToolCall,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
  logger,
  ModelType,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  streamText,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";
import type { LMStudioModelInfo } from "../types";
import { createLMStudioClient } from "../utils/client";
import { getBaseURL, getLargeModel, getSmallModel } from "../utils/config";
import { detectLMStudio } from "../utils/detect";
import { emitModelUsed, estimateUsage, normalizeTokenUsage } from "../utils/model-usage";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

type TextModelType =
  | typeof TEXT_NANO_MODEL_TYPE
  | typeof ModelType.TEXT_SMALL
  | typeof TEXT_MEDIUM_MODEL_TYPE
  | typeof ModelType.TEXT_LARGE
  | typeof TEXT_MEGA_MODEL_TYPE
  | typeof RESPONSE_HANDLER_MODEL_TYPE
  | typeof ACTION_PLANNER_MODEL_TYPE;

/**
 * `GenerateTextParams` widened with the fields ElizaOS core sends alongside the documented
 * prompt parameters — messages, tools, toolChoice and an optional response schema. Typed
 * loosely (matching plugin-ollama) because callers cross several runtime versions.
 */
type GenerateTextParamsWithNativeOptions = Omit<GenerateTextParams, "responseSchema"> & {
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  responseSchema?: unknown;
};

type NativeTextOutput = NonNullable<Parameters<typeof generateText>[0]["output"]>;
type NativeTextModelResult = string & GenerateTextResult;

const _firstModelIdCache = new WeakMap<IAgentRuntime, Promise<string | null>>();

/**
 * Resolves a model identifier for a given tier. Order of resolution:
 *
 * 1. `LMSTUDIO_<TIER>_MODEL` env (e.g. `LMSTUDIO_SMALL_MODEL`).
 * 2. Generic `<TIER>_MODEL` env fallback.
 * 3. First model returned by `GET /v1/models` — LM Studio always returns at least the
 *    currently-loaded model, so this gives a useful default without per-install config.
 *
 * The detection result is cached per runtime so we don't hit `/v1/models` on every call.
 */
async function resolveModelForType(
  runtime: IAgentRuntime,
  modelType: TextModelType
): Promise<string> {
  // Tier-specific overrides win.
  if (
    modelType === ModelType.TEXT_LARGE ||
    modelType === TEXT_MEGA_MODEL_TYPE ||
    modelType === ACTION_PLANNER_MODEL_TYPE
  ) {
    const large = getLargeModel(runtime);
    if (large) return large;
  } else {
    const small = getSmallModel(runtime);
    if (small) return small;
  }

  // Fall back to LM Studio's first reported model.
  let pending = _firstModelIdCache.get(runtime);
  if (!pending) {
    pending = (async (): Promise<string | null> => {
      const result = await detectLMStudio({
        baseURL: getBaseURL(runtime),
        fetcher: runtime.fetch ?? undefined,
      });
      if (!result.available || !result.models || result.models.length === 0) {
        return null;
      }
      const first: LMStudioModelInfo = result.models[0] as LMStudioModelInfo;
      return first.id;
    })();
    _firstModelIdCache.set(runtime, pending);
  }

  const resolved = await pending;
  if (resolved) {
    return resolved;
  }

  throw new Error(
    "[LMStudio] No model configured and `GET /v1/models` returned no entries. Set LMSTUDIO_SMALL_MODEL / LMSTUDIO_LARGE_MODEL or load a model in LM Studio."
  );
}

function summarizeAiSdkError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) {
    return { note: "max depth summarizing nested error" };
  }
  if (error == null) {
    return { raw: String(error) };
  }
  if (typeof error !== "object") {
    return { message: String(error) };
  }
  const e = error as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof e.name === "string") out.errorName = e.name;
  if (typeof e.message === "string") out.message = e.message;
  if (typeof e.url === "string") out.requestUrl = e.url;
  if (typeof e.statusCode === "number") out.httpStatus = e.statusCode;
  if (typeof e.responseBody === "string") out.lmstudioResponseBody = e.responseBody;
  if (e.cause != null && typeof e.cause === "object") {
    out.cause = summarizeAiSdkError(e.cause, depth + 1);
  }
  return out;
}

function logTextFailure(
  phase: "generateText" | "streamText.textStream",
  modelType: TextModelType,
  modelId: string,
  endpoint: string,
  error: unknown
): void {
  logger.error(
    {
      src: "plugin:lmstudio:text",
      phase,
      modelType,
      modelId,
      lmstudioBaseURL: endpoint,
      ...summarizeAiSdkError(error),
    },
    `[LMStudio] ${phase} failed (${modelType}, model=${modelId}).`
  );
}

function buildStructuredOutput(responseSchema: unknown): NativeTextOutput {
  if (
    responseSchema &&
    typeof responseSchema === "object" &&
    "responseFormat" in responseSchema &&
    "parseCompleteOutput" in responseSchema
  ) {
    return responseSchema as NativeTextOutput;
  }

  const schemaOptions =
    responseSchema && typeof responseSchema === "object" && "schema" in responseSchema
      ? (responseSchema as { schema: unknown; name?: string; description?: string })
      : { schema: responseSchema };

  return Output.object({
    schema: jsonSchema(schemaOptions.schema as JSONSchema7),
    ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
    ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
  }) as NativeTextOutput;
}

function serializeStructuredResult(result: { text: string; output: unknown }): string {
  if (result.output !== undefined && result.output !== null) {
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  }
  const trimmed = result.text?.trim() ?? "";
  if (trimmed) return trimmed;
  throw new Error("[LMStudio] Structured generation returned no text or output.");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function inferJsonSchemaType(schema: Record<string, unknown>, isRoot: boolean): string | undefined {
  if ("items" in schema && !("properties" in schema)) {
    return "array";
  }
  if (
    "properties" in schema ||
    "required" in schema ||
    "additionalProperties" in schema ||
    isRoot
  ) {
    return "object";
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

function sanitizeJsonSchema(schema: unknown, isRoot = false): JSONSchema7 {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
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

export function normalizeNativeTools(tools: unknown): ToolSet | undefined {
  if (!tools) {
    return undefined;
  }
  if (!Array.isArray(tools)) {
    return tools as ToolSet;
  }

  const toolSet: Record<string, unknown> = {};
  for (const rawTool of tools) {
    const tool = asRecord(rawTool);
    const functionTool = asRecord(tool.function);
    const name = firstString(tool.name, functionTool.name);

    if (!name) {
      throw new Error("[LMStudio] Native tool definition is missing a name.");
    }

    const description = firstString(tool.description, functionTool.description);
    const rawSchema =
      tool.parameters ?? functionTool.parameters ?? ({ type: "object" } satisfies JSONSchema7);
    const inputSchema = sanitizeJsonSchema(rawSchema, true);

    toolSet[name] = {
      ...(description ? { description } : {}),
      inputSchema: jsonSchema(inputSchema as JSONSchema7),
    };
  }
  return Object.keys(toolSet).length > 0 ? (toolSet as ToolSet) : undefined;
}

export function normalizeToolChoice(toolChoice: unknown): ToolChoice<ToolSet> | undefined {
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
  return toolChoice as ToolChoice<ToolSet>;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function normalizeUserContent(content: unknown): UserContent {
  if (Array.isArray(content)) {
    return content as UserContent;
  }
  return stringifyMessageContent(content);
}

function normalizeNativeMessage(message: unknown): ModelMessage {
  const raw = asRecord(message);
  if (raw.role === "system") {
    return {
      role: "system",
      content: stringifyMessageContent(raw.content),
    } as ModelMessage;
  }
  if (raw.role === "assistant") {
    return {
      role: "assistant",
      content:
        typeof raw.content === "string" || Array.isArray(raw.content) ? raw.content : "",
    } as ModelMessage;
  }
  if (raw.role === "tool") {
    return {
      role: "tool",
      content: Array.isArray(raw.content)
        ? raw.content
        : [
            {
              type: "tool-result",
              toolCallId: String(firstString(raw.toolCallId, raw.id) ?? "tool-call"),
              toolName: String(firstString(raw.toolName, raw.name) ?? "tool"),
              output: {
                type: "text",
                value: stringifyMessageContent(raw.content),
              },
            },
          ],
    } as ModelMessage;
  }
  return {
    role: "user",
    content: normalizeUserContent(raw.content),
  } as ModelMessage;
}

export function normalizeNativeMessages(messages: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  return messages.map((m) => normalizeNativeMessage(m));
}

function mapToolCalls(toolCalls: unknown[] | undefined): ToolCall[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }
  const out: ToolCall[] = [];
  for (const raw of toolCalls) {
    const r = asRecord(raw);
    const id = String(firstString(r.toolCallId, r.id) ?? "");
    const name = String(firstString(r.toolName, r.name) ?? "").trim();
    if (!name) continue;

    const rawInput = r.input ?? r.arguments ?? r.args;
    let args: Record<string, unknown> | string;
    if (typeof rawInput === "string") {
      const parsed = parseJsonIfPossible(rawInput);
      args =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : rawInput;
    } else if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      args = rawInput as Record<string, unknown>;
    } else {
      args = {};
    }
    out.push({ id, name, arguments: args } as ToolCall);
  }
  return out;
}

function buildNativeResultCast(
  result: Awaited<ReturnType<typeof generateText>>,
  modelName: string,
  usage: TokenUsage
): string {
  const payload: GenerateTextResult = {
    text: result.text,
    toolCalls: mapToolCalls(result.toolCalls as unknown[] | undefined),
    finishReason: String(result.finishReason ?? ""),
    usage,
    providerMetadata: { modelName },
  };
  return payload as NativeTextModelResult;
}

type StreamTextParams = Parameters<typeof streamText>[0];

function buildStreamResult(args: {
  runtime: IAgentRuntime;
  modelType: TextModelType;
  model: string;
  endpoint: string;
  streamParams: StreamTextParams;
  promptForEstimate: string;
}): TextStreamResult {
  const streamResult = streamText(args.streamParams);
  const textPromise = Promise.resolve(streamResult.text).catch(() => "");
  const finishReasonPromise = Promise.resolve(streamResult.finishReason).catch(
    () => undefined
  ) as Promise<string | undefined>;
  const usagePromise = Promise.resolve(streamResult.usage)
    .then(async (usage) => {
      const fullText = await textPromise;
      const normalized =
        normalizeTokenUsage(usage) ?? estimateUsage(args.promptForEstimate, fullText);
      emitModelUsed(args.runtime, args.modelType, args.model, normalized);
      return normalized;
    })
    .catch(() => undefined);

  async function* textStreamWithUsage(): AsyncIterable<string> {
    let completed = false;
    try {
      for await (const chunk of streamResult.textStream) {
        yield chunk;
      }
      completed = true;
    } catch (err) {
      logTextFailure("streamText.textStream", args.modelType, args.model, args.endpoint, err);
      throw err;
    } finally {
      if (completed) {
        await usagePromise.catch(() => undefined);
      }
    }
  }

  return {
    textStream: textStreamWithUsage(),
    text: textPromise,
    usage: usagePromise,
    finishReason: finishReasonPromise,
  };
}

async function handleTextWithModelType(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const extended = params as GenerateTextParamsWithNativeOptions;
  const responseSchema = extended.responseSchema;
  const tools = normalizeNativeTools(extended.tools);

  const {
    prompt,
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  } = params;

  let modelIdForLog = "";
  const baseURL = getBaseURL(runtime);

  try {
    const client = createLMStudioClient(runtime);
    const model = await resolveModelForType(runtime, modelType);
    modelIdForLog = model;

    logger.log(`[LMStudio] Using ${modelType} model: ${model}`);

    const system = resolveEffectiveSystemPrompt({
      params,
      fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
    });

    let outputSpec: NativeTextOutput | undefined =
      responseSchema !== undefined && responseSchema !== null
        ? buildStructuredOutput(responseSchema)
        : undefined;

    if (tools && outputSpec) {
      logger.debug(
        "[LMStudio] tools and responseSchema both present — omitting structured output for this call."
      );
      outputSpec = undefined;
    }

    const wireRaw = dropDuplicateLeadingSystemMessage(
      extended.messages as Parameters<typeof dropDuplicateLeadingSystemMessage>[0],
      system
    );
    const normalizedMessages = normalizeNativeMessages(wireRaw);
    const hasChatMessages = Array.isArray(normalizedMessages) && normalizedMessages.length > 0;
    const toolChoice = tools ? normalizeToolChoice(extended.toolChoice) : undefined;
    const shouldReturnNative = Boolean(
      hasChatMessages || tools || extended.toolChoice || outputSpec !== undefined
    );

    const renderedPrompt = hasChatMessages
      ? ""
      : (renderChatMessagesForPrompt(params.messages, {
          omitDuplicateSystem: system,
        }) ??
        prompt ??
        "");

    const promptOrMessages = hasChatMessages
      ? { messages: normalizedMessages }
      : { prompt: renderedPrompt };

    const resolvedStopSequences =
      Array.isArray(params.stopSequences) && params.stopSequences.length > 0
        ? params.stopSequences
        : undefined;

    const promptForUsageEstimate = hasChatMessages
      ? JSON.stringify(normalizedMessages)
      : renderedPrompt;

    const baseArgs = {
      model: client(model) as LanguageModel,
      ...promptOrMessages,
      system,
      temperature,
      maxOutputTokens: maxTokens,
      frequencyPenalty,
      presencePenalty,
      ...(resolvedStopSequences ? { stopSequences: resolvedStopSequences } : {}),
      ...(tools ? { tools, ...(toolChoice ? { toolChoice } : {}) } : {}),
      ...(outputSpec ? { output: outputSpec } : {}),
    };

    // Streaming branches — we only forward via `streamText` when there is no structured
    // output and no toolChoice without tools; structured + streaming combinations vary
    // across LM Studio model engines, so we conservatively go through generateText there.
    if (params.stream && !outputSpec && !(extended.toolChoice && !tools)) {
      return buildStreamResult({
        runtime,
        modelType,
        model,
        endpoint: baseURL,
        streamParams: baseArgs as StreamTextParams,
        promptForEstimate: promptForUsageEstimate,
      });
    }

    const result = await generateText(baseArgs);
    const usage =
      normalizeTokenUsage(result.usage) ?? estimateUsage(promptForUsageEstimate, result.text);
    emitModelUsed(runtime, modelType, model, usage);

    if (shouldReturnNative) {
      if (outputSpec !== undefined) {
        return serializeStructuredResult(result);
      }
      return buildNativeResultCast(result, model, usage);
    }
    return result.text;
  } catch (error) {
    logTextFailure("generateText", modelType, modelIdForLog || "(unknown)", baseURL, error);
    return "Error generating text. Please try again later.";
  }
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, ModelType.TEXT_SMALL, params);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, TEXT_NANO_MODEL_TYPE, params);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, TEXT_MEDIUM_MODEL_TYPE, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, ModelType.TEXT_LARGE, params);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, TEXT_MEGA_MODEL_TYPE, params);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, RESPONSE_HANDLER_MODEL_TYPE, params);
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return handleTextWithModelType(runtime, ACTION_PLANNER_MODEL_TYPE, params);
}
