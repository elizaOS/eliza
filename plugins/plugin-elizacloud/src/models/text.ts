import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  logger,
  ModelType,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
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

function normalizeNativeTools(tools: unknown): unknown[] | undefined {
  if (!tools) {
    return undefined;
  }

  if (Array.isArray(tools)) {
    return tools;
  }

  const toolSet = asRecord(tools);
  const normalized: unknown[] = [];
  for (const [name, rawTool] of Object.entries(toolSet)) {
    const tool = asRecord(rawTool);
    const inputSchema = unwrapJsonSchema(
      tool.inputSchema ?? tool.parameters ?? tool.schema ?? { type: "object" }
    );
    normalized.push({
      type: "function",
      function: {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: inputSchema,
      },
    });
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

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const { modelName, prompt, systemPrompt } = buildGenerateParams(runtime, modelType, params);
  const paramsWithNative = params as GenerateTextParamsWithNativeOptions;

  logger.debug(`[ELIZAOS_CLOUD] Generating text with ${modelType} model: ${modelName}`);

  if (params.stream) {
    logger.debug(
      "[ELIZAOS_CLOUD] Streaming text disabled for responses compatibility; falling back to buffered response."
    );
  }

  logger.log(`[ELIZAOS_CLOUD] Using ${modelType} model: ${modelName}`);
  logger.log(prompt);

  if (hasNativeTransportOptions(paramsWithNative)) {
    const nativeResult = await generateNativeChatCompletion(runtime, modelType, paramsWithNative, {
      modelName,
      prompt,
      systemPrompt,
    });
    return shouldReturnNativeResult(paramsWithNative)
      ? (nativeResult as unknown as string)
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
    max_output_tokens: params.maxTokens ?? 8192,
  };
  if (!reasoning && typeof params.temperature === "number") {
    requestBody.temperature = params.temperature;
  }

  const response = await createCloudApiClient(runtime).requestRaw("POST", "/responses", {
    headers: {
      "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
      "X-Eliza-Model-Type": modelType,
    },
    json: requestBody,
  });
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
    emitModelUsageEvent(runtime, modelType, prompt, {
      inputTokens: data.usage.input_tokens ?? 0,
      outputTokens: data.usage.output_tokens ?? 0,
      totalTokens: data.usage.total_tokens ?? 0,
    });
  }

  const text = extractResponsesOutputText(data);
  if (!text.trim()) {
    throw new Error("elizaOS Cloud returned no text response");
  }

  return text;
}

async function generateNativeChatCompletion(
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
  const response = await createCloudApiClient(runtime).requestRaw("POST", "/chat/completions", {
    headers: {
      "X-Eliza-Llm-Purpose": getPurposeForModelType(modelType),
      "X-Eliza-Model-Type": modelType,
    },
    json: requestBody,
  });
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
    emitModelUsageEvent(runtime, modelType, context.prompt, usage);
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
