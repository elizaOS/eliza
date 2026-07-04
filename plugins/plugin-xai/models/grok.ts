/**
 * xAI Grok model handlers for text generation (small/large) and embeddings,
 * calling the xAI OpenAI-compatible chat/embeddings endpoints (api.x.ai/v1).
 * Normalizes base URL and model-name settings, emits MODEL_USED events, and
 * records LLM calls for usage accounting. Consumed by the plugin in
 * ../index.ts.
 */
import {
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
  ElizaError,
  type EventPayload,
  EventType,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
  type ModelTypeName,
  recordLlmCall,
  resolveEffectiveSystemPrompt,
  type TextEmbeddingParams,
  type TextStreamResult,
} from "@elizaos/core";

const XAI_API_BASE = "https://api.x.ai/v1";

const DEFAULT_MODELS = {
  small: "grok-3-mini",
  large: "grok-3",
  embedding: "grok-embedding",
} as const;

interface GrokConfig {
  apiKey: string;
  baseUrl: string;
  smallModel: string;
  largeModel: string;
  embeddingModel: string;
}

function getSettingString(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeBaseUrl(value: unknown): string {
  const raw =
    typeof value === "string" && value.trim() ? value.trim() : XAI_API_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — names the misconfigured
    // setting; the original URL parse failure travels as `cause`.
    throw new Error("XAI_BASE_URL must be a valid URL", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("XAI_BASE_URL must use http or https");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeModelName(
  value: unknown,
  fallback: string,
  settingName: string,
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${settingName} must be a non-empty string`);
  }
  return value.trim();
}

function getConfig(runtime: IAgentRuntime): GrokConfig {
  const apiKey =
    getSettingString(runtime, "XAI_API_KEY") ??
    getSettingString(runtime, "GROK_API_KEY");
  if (!apiKey) {
    throw new Error("XAI_API_KEY is required");
  }

  const baseUrl = runtime.getSetting("XAI_BASE_URL");
  const smallModel = runtime.getSetting("XAI_SMALL_MODEL");
  const largeModel =
    runtime.getSetting("XAI_MODEL") || runtime.getSetting("XAI_LARGE_MODEL");
  const embeddingModel = runtime.getSetting("XAI_EMBEDDING_MODEL");

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    smallModel: normalizeModelName(
      smallModel,
      DEFAULT_MODELS.small,
      "XAI_SMALL_MODEL",
    ),
    largeModel: normalizeModelName(
      largeModel,
      DEFAULT_MODELS.large,
      "XAI_MODEL",
    ),
    embeddingModel: normalizeModelName(
      embeddingModel,
      DEFAULT_MODELS.embedding,
      "XAI_EMBEDDING_MODEL",
    ),
  };
}

function getFetch(runtime: IAgentRuntime): typeof fetch {
  const runtimeFetch = (runtime as { fetch?: typeof fetch }).fetch;
  return typeof runtimeFetch === "function"
    ? runtimeFetch.bind(runtime)
    : fetch;
}

function getAuthHeader(config: GrokConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[];
  tool_call_id?: string;
  tool_calls?: unknown[];
  name?: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface XaiNativeTextResult {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

type XaiToolDefinition = {
  type?: "function";
  name?: string;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
};

type XaiToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | { type: "tool"; toolName: string }
  | { name: string };

function normalizeXaiTools(tools: unknown): unknown[] | undefined {
  if (!tools) return undefined;
  if (Array.isArray(tools)) {
    return tools
      .map((tool) => normalizeXaiTool(tool as XaiToolDefinition))
      .filter((tool): tool is Record<string, unknown> => tool !== undefined);
  }
  if (typeof tools === "object") {
    const out: Record<string, unknown>[] = [];
    for (const [name, value] of Object.entries(
      tools as Record<string, XaiToolDefinition>,
    )) {
      const normalized = normalizeXaiTool({ ...value, name });
      if (normalized) out.push(normalized);
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function normalizeXaiTool(
  tool: XaiToolDefinition,
): Record<string, unknown> | undefined {
  const name = tool.name ?? tool.function?.name;
  if (!name) return undefined;
  const description = tool.description ?? tool.function?.description;
  const parameters = tool.parameters ??
    tool.function?.parameters ??
    tool.inputSchema ?? { type: "object" };
  return {
    type: "function",
    function: {
      name,
      ...(description ? { description } : {}),
      parameters,
    },
  };
}

function normalizeXaiToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice) return undefined;
  if (
    typeof toolChoice === "string" &&
    (toolChoice === "auto" ||
      toolChoice === "none" ||
      toolChoice === "required")
  ) {
    return toolChoice;
  }
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "function") return toolChoice;
  if (choice.type === "tool" && typeof choice.toolName === "string") {
    return { type: "function", function: { name: choice.toolName } };
  }
  if (typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function buildXaiResponseFormat(responseSchema: unknown): unknown {
  if (!responseSchema) return undefined;
  const r = responseSchema as Record<string, unknown>;
  const schema = (r.schema ?? responseSchema) as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : "structured_response";
  return {
    type: "json_schema",
    json_schema: { name, schema, strict: true },
  };
}

interface StreamCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  usage?: OpenAIUsage;
  model?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface EmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

type NormalizedUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value));
}

function normalizeTokenUsage(usage: unknown): NormalizedUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const record = usage as OpenAIUsage;
  const promptTokens = toFiniteNumber(
    record.prompt_tokens ?? record.inputTokens,
  );
  const completionTokens = toFiniteNumber(
    record.completion_tokens ?? record.outputTokens,
  );
  const totalTokens = toFiniteNumber(record.total_tokens ?? record.totalTokens);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  const normalizedPromptTokens =
    promptTokens ??
    (completionTokens === undefined && totalTokens !== undefined
      ? totalTokens
      : Math.max(0, (totalTokens ?? 0) - (completionTokens ?? 0)));
  const normalizedCompletionTokens =
    completionTokens ??
    Math.max(
      0,
      (totalTokens ?? normalizedPromptTokens) - normalizedPromptTokens,
    );

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens:
      totalTokens ?? normalizedPromptTokens + normalizedCompletionTokens,
  };
}

function estimateTokenCount(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function estimateUsage(prompt: string, response: unknown): NormalizedUsage {
  const promptTokens = estimateTokenCount(prompt);
  const completionTokens = estimateTokenCount(
    typeof response === "string" ? response : String(response),
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function estimateEmbeddingUsage(text: string): NormalizedUsage {
  const promptTokens = estimateTokenCount(text);
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    estimated: true,
  };
}

function sanitizeTemperature(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("temperature must be a finite number");
  }
  return Math.min(2, Math.max(0, value));
}

function sanitizeMaxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new Error("maxTokens must be a positive finite integer");
  }
  return value;
}

function sanitizeStopSequences(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("stopSequences must be an array of strings");
  }
  return value;
}

function normalizePrompt(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error("prompt must be a string");
  }
  return value;
}

function normalizeEmbeddingText(
  params: TextEmbeddingParams | string | null,
): string {
  if (params === null) {
    throw new Error("Null params provided for embedding");
  }
  if (typeof params === "string") return params.trim();
  if (
    !params ||
    typeof params !== "object" ||
    typeof params.text !== "string"
  ) {
    throw new Error("Embedding text must be a string");
  }
  return params.text.trim();
}

function validateEmbeddingVector(embedding: unknown): number[] {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("No embedding in Grok response");
  }
  if (
    embedding.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    throw new Error("Grok embedding response contained non-finite values");
  }
  return embedding;
}

function emitModelUsed(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  model: string,
  usage: NormalizedUsage,
): void {
  void runtime.emitEvent(
    EventType.MODEL_USED as string,
    {
      runtime,
      source: "xai",
      provider: "xai",
      type,
      model,
      modelName: model,
      tokens: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
        ...(usage.estimated ? { estimated: true } : {}),
      },
      ...(usage.estimated ? { usageEstimated: true } : {}),
    } as EventPayload,
  );
}

async function generateText(
  runtime: IAgentRuntime,
  config: GrokConfig,
  modelType: ModelTypeName,
  model: string,
  params: GenerateTextParams,
): Promise<string | TextStreamResult | XaiNativeTextResult> {
  const paramsWithNative = params as GenerateTextParams & {
    messages?: ChatMessage[];
    tools?: unknown;
    toolChoice?: XaiToolChoice;
    responseSchema?: unknown;
  };
  const promptText = normalizePrompt(params.prompt);
  const tools = normalizeXaiTools(paramsWithNative.tools);
  const toolChoice = normalizeXaiToolChoice(paramsWithNative.toolChoice);
  const responseFormat = buildXaiResponseFormat(
    paramsWithNative.responseSchema,
  );
  const returnNative = Boolean(
    paramsWithNative.messages ||
      paramsWithNative.tools ||
      paramsWithNative.toolChoice ||
      paramsWithNative.responseSchema,
  );

  // xAI's chat API carries the system instruction as a leading system message;
  // dropping it here would strip both caller-provided `params.system` and the
  // character identity from every request.
  const systemPrompt = resolveEffectiveSystemPrompt({
    params: paramsWithNative,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
  const rawMessages: ChatMessage[] = paramsWithNative.messages?.length
    ? (paramsWithNative.messages as ChatMessage[])
    : [{ role: "user", content: promptText }];
  const wireMessages = systemPrompt
    ? (dropDuplicateLeadingSystemMessage(rawMessages, systemPrompt) ??
      rawMessages)
    : rawMessages;
  const messages: ChatMessage[] =
    systemPrompt && wireMessages[0]?.role !== "system"
      ? [{ role: "system", content: systemPrompt }, ...wireMessages]
      : wireMessages;

  const body: Record<string, unknown> = {
    model,
    messages,
  };

  const temperature = sanitizeTemperature(params.temperature);
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  const maxTokens = params.omitMaxTokens
    ? undefined
    : sanitizeMaxTokens(params.maxTokens);
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }
  const stopSequences = sanitizeStopSequences(params.stopSequences);
  if (stopSequences) {
    body.stop = stopSequences;
  }
  if (tools) {
    body.tools = tools;
  }
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }
  if (responseFormat) {
    body.response_format = responseFormat;
  }

  if (params.stream && params.onStreamChunk) {
    return createStreamTextResult(
      runtime,
      config,
      modelType,
      model,
      params,
      body,
      promptText,
    );
  }

  if (params.stream) {
    return createStreamTextResult(
      runtime,
      config,
      modelType,
      model,
      params,
      body,
      promptText,
    );
  }

  return recordLlmCall(
    runtime,
    {
      model,
      systemPrompt: systemPrompt ?? "",
      userPrompt: promptText,
      temperature: params.temperature ?? 0,
      maxTokens: params.maxTokens ?? 0,
      purpose: "external_llm",
      actionType: "xai.chat.completions.create",
    },
    async () => {
      const response = await getFetch(runtime)(
        `${config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: getAuthHeader(config),
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Grok API error (${response.status}): ${error}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;

      const choice = data.choices?.[0];
      const rawText = choice?.message?.content ?? "";
      const rawToolCalls = choice?.message?.tool_calls ?? [];

      if (!returnNative && !rawText) {
        throw new Error("No content in Grok response");
      }

      // A native completion with no text and no tool calls is a provider
      // failure (empty choices, moderation, truncation) — never a legitimate
      // result. Returning an empty native shape would fabricate a
      // healthy-empty completion and emit success usage telemetry for it
      // (#9324: throw, never fabricate). Tool-call-only completions pass.
      if (!rawText && rawToolCalls.length === 0) {
        throw new ElizaError(
          `[xAI] ${modelType} returned an empty completion${
            choice?.finish_reason
              ? ` (finishReason: ${choice.finish_reason})`
              : ""
          }`,
          {
            code: "MODEL_EMPTY_COMPLETION",
            context: { modelType, model, finishReason: choice?.finish_reason },
          },
        );
      }

      emitModelUsed(
        runtime,
        modelType,
        data.model || model,
        normalizeTokenUsage(data.usage) ??
          estimateUsage(params.prompt ?? "", rawText),
      );

      if (returnNative) {
        const usage = normalizeTokenUsage(data.usage);
        const native: XaiNativeTextResult = {
          text: rawText,
          toolCalls: rawToolCalls.map((tc) => ({
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: parseJsonOrRaw(tc.function.arguments),
          })),
          finishReason: choice?.finish_reason,
          ...(usage
            ? {
                usage: {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                },
              }
            : {}),
        };
        return native;
      }

      return rawText;
    },
  );
}

function createStreamTextResult(
  runtime: IAgentRuntime,
  config: GrokConfig,
  modelType: ModelTypeName,
  model: string,
  params: GenerateTextParams,
  body: Record<string, unknown>,
  promptText: string,
): TextStreamResult {
  body.stream = true;
  const onStreamChunk = params.onStreamChunk;
  const fetchImpl = getFetch(runtime);
  const state = recordLlmCall(
    runtime,
    {
      model,
      systemPrompt: "",
      userPrompt: promptText,
      temperature: params.temperature ?? 0,
      maxTokens: params.maxTokens ?? 0,
      purpose: "external_llm",
      actionType: "xai.chat.completions.stream",
    },
    async () => {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: getAuthHeader(config),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Grok API error (${response.status}): ${error}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let buffered = "";
      let usage: NormalizedUsage | null = null;
      let responseModel = model;
      let finishReason: string | undefined;

      const readLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") return;

        const parsed = JSON.parse(data) as StreamCompletionChunk & {
          choices?: Array<{
            finish_reason?: string;
            delta?: { content?: string };
          }>;
        };
        const chunkUsage = normalizeTokenUsage(parsed.usage);
        if (chunkUsage) {
          usage = chunkUsage;
        }
        if (typeof parsed.model === "string" && parsed.model.length > 0) {
          responseModel = parsed.model;
        }

        const choice = parsed.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const content = choice?.delta?.content;
        if (content) {
          chunks.push(content);
          onStreamChunk?.(content);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          readLine(line);
        }
      }

      buffered += decoder.decode();
      for (const line of buffered.split(/\r?\n/)) {
        readLine(line);
      }

      const fullText = chunks.join("");
      // A stream that delivered zero content chunks is a provider failure
      // (empty body, non-SSE payload, moderation) — ending it as a healthy ""
      // completion with success usage telemetry would hide the broken
      // pipeline from the planner (#9324: throw, never fabricate).
      if (chunks.length === 0) {
        throw new ElizaError(
          `[xAI] ${modelType} stream produced no content${
            finishReason ? ` (finishReason: ${finishReason})` : ""
          }`,
          {
            code: "MODEL_EMPTY_COMPLETION",
            context: { modelType, model, finishReason },
          },
        );
      }
      const finalUsage = usage ?? estimateUsage(promptText, fullText);
      emitModelUsed(runtime, modelType, responseModel, finalUsage);

      return {
        fullText,
        chunks,
        usage: finalUsage,
        finishReason,
      };
    },
  );

  // error-policy:J5 unhandled-rejection suppression — consumers typically
  // iterate only `textStream`; the companion promises (text/usage/finishReason)
  // would otherwise each surface a stream failure as an unhandled rejection.
  // The failure IS observed by the textStream consumer (the generator awaits
  // `state` and rethrows). Mirrors plugin-anthropic/plugin-openai
  // `handledPromise`.
  const handledPromise = <T>(value: T | PromiseLike<T>): Promise<T> => {
    const promise = Promise.resolve(value);
    promise.catch(() => {});
    return promise;
  };

  return {
    textStream: (async function* () {
      const result = await state;
      yield* result.chunks;
    })(),
    text: handledPromise(state.then((result) => result.fullText)),
    usage: handledPromise(state.then((result) => result.usage)),
    finishReason: handledPromise(state.then((result) => result.finishReason)),
  };
}

function parseJsonOrRaw(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — model-emitted tool-call
    // arguments that are not valid JSON pass through as the raw string, so
    // the consumer sees exactly what the model produced; nothing fake-valid
    // is fabricated.
    return value;
  }
}

async function createEmbedding(
  runtime: IAgentRuntime,
  config: GrokConfig,
  text: string,
): Promise<number[]> {
  const response = await getFetch(runtime)(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: getAuthHeader(config),
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grok Embedding API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as EmbeddingResponse;

  const embedding = validateEmbeddingVector(data.data?.[0]?.embedding);

  emitModelUsed(
    runtime,
    ModelType.TEXT_EMBEDDING,
    data.model || config.embeddingModel,
    normalizeTokenUsage(data.usage) ?? estimateEmbeddingUsage(text),
  );
  return embedding;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  const config = getConfig(runtime);
  logger.debug(`[Grok] Generating text with model: ${config.smallModel}`);
  // Native result (with toolCalls) is cast through the string return type:
  // elizaOS's plugin Model handler signature is
  // `Promise<string | TextStreamResult>`. Consumers that pass `tools` /
  // `messages` / `responseSchema` / `toolChoice` unwrap the native shape from
  // `useModel`.
  return (await generateText(
    runtime,
    config,
    ModelType.TEXT_SMALL,
    config.smallModel,
    params,
  )) as string | TextStreamResult;
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  const config = getConfig(runtime);
  logger.debug(`[Grok] Generating text with model: ${config.largeModel}`);
  return (await generateText(
    runtime,
    config,
    ModelType.TEXT_LARGE,
    config.largeModel,
    params,
  )) as string | TextStreamResult;
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
): Promise<number[]> {
  const config = getConfig(runtime);
  const text = normalizeEmbeddingText(params);
  if (!text) {
    throw new Error("Empty text provided for embedding");
  }
  logger.debug(
    `[Grok] Creating embedding with model: ${config.embeddingModel}`,
  );
  return createEmbedding(runtime, config, text);
}

export async function listModels(
  runtime: IAgentRuntime,
): Promise<Record<string, unknown>[]> {
  const config = getConfig(runtime);

  const response = await fetch(`${config.baseUrl}/models`, {
    headers: getAuthHeader(config),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grok API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { data: Record<string, unknown>[] };
  return data.data;
}

export function isGrokConfigured(runtime: IAgentRuntime): boolean {
  return !!(
    getSettingString(runtime, "XAI_API_KEY") ??
    getSettingString(runtime, "GROK_API_KEY")
  );
}
