import type {
  ChatMessage,
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ModelTypeName,
  ObjectGenerationParams,
  Plugin,
  RecordLlmCallDetails,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "@elizaos/core";
import { EventType, logger, ModelType, recordLlmCall } from "@elizaos/core";

const DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";
const DEFAULT_SMALL_MODEL = "gpt-oss-120b";
const DEFAULT_LARGE_MODEL = "gpt-oss-120b";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

type ProcessEnvLike = Record<string, string | undefined>;

type ProviderOptions = {
  agentName?: string;
  cerebras?: CerebrasProviderOptions;
  [key: string]: unknown;
};

type CerebrasProviderOptions = {
  promptCacheKey?: string;
  prompt_cache_key?: string;
  payloadEncoding?: "json" | "gzip" | "msgpack";
  encodePayload?: (payload: Record<string, unknown>) => BodyInit | Promise<BodyInit>;
  contentType?: string;
  headers?: Record<string, string>;
};

type GenerateTextParamsWithProviderOptions = GenerateTextParams & {
  providerOptions?: ProviderOptions;
  prompt_cache_key?: string;
};

type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

type TextResult = {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    cacheReadInputTokens?: number;
  };
};

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

function getEnvValue(key: string): string | undefined {
  return getProcessEnv()[key];
}

function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue?: string
): string | undefined {
  const value = runtime.getSetting(key);
  if (value !== undefined && value !== null) {
    return String(value);
  }
  return getEnvValue(key) ?? defaultValue;
}

function getBooleanSetting(runtime: IAgentRuntime, key: string, defaultValue: boolean): boolean {
  const value = getSetting(runtime, key);
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

function getBaseURL(runtime: IAgentRuntime): string {
  return getSetting(runtime, "CEREBRAS_BASE_URL", DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;
}

function getApiKey(runtime: IAgentRuntime): string | undefined {
  if (isBrowser() && !getBooleanSetting(runtime, "CEREBRAS_ALLOW_BROWSER_API_KEY", false)) {
    return undefined;
  }
  return getSetting(runtime, "CEREBRAS_API_KEY");
}

function getSmallModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_SMALL_MODEL") ??
    getSetting(runtime, "SMALL_MODEL") ??
    DEFAULT_SMALL_MODEL
  );
}

function getNanoModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_NANO_MODEL") ??
    getSetting(runtime, "NANO_MODEL") ??
    getSmallModel(runtime)
  );
}

function getMediumModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_MEDIUM_MODEL") ??
    getSetting(runtime, "MEDIUM_MODEL") ??
    getSmallModel(runtime)
  );
}

function getLargeModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_LARGE_MODEL") ??
    getSetting(runtime, "LARGE_MODEL") ??
    DEFAULT_LARGE_MODEL
  );
}

function getMegaModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_MEGA_MODEL") ??
    getSetting(runtime, "MEGA_MODEL") ??
    getLargeModel(runtime)
  );
}

function getResponseHandlerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "CEREBRAS_SHOULD_RESPOND_MODEL") ??
    getSetting(runtime, "RESPONSE_HANDLER_MODEL") ??
    getSetting(runtime, "SHOULD_RESPOND_MODEL") ??
    getNanoModel(runtime)
  );
}

function getActionPlannerModel(runtime: IAgentRuntime): string {
  return (
    getSetting(runtime, "CEREBRAS_ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "CEREBRAS_PLANNER_MODEL") ??
    getSetting(runtime, "ACTION_PLANNER_MODEL") ??
    getSetting(runtime, "PLANNER_MODEL") ??
    getLargeModel(runtime)
  );
}

function getFetch(runtime: IAgentRuntime): typeof fetch {
  return (runtime.fetch as typeof fetch | undefined) ?? fetch;
}

function shouldReturnNativeResult(params: GenerateTextParams): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

/**
 * Convert a ChatMessage (camelCase) to the OpenAI-compatible HTTP API format
 * (snake_case). Cerebras's /v1/chat/completions endpoint rejects `toolCalls`
 * and `toolCallId` — it requires `tool_calls` and `tool_call_id`.
 */
function toCerebrasApiMessage(msg: ChatMessage): Record<string, unknown> {
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: tc.type ?? "function",
        function: {
          name: typeof tc.name === "string" ? tc.name : "",
          arguments:
            typeof tc.arguments === "string"
              ? tc.arguments
              : JSON.stringify(tc.arguments ?? {}),
        },
      })),
    };
  }
  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: msg.toolCallId ?? "",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
    };
  }
  // system / user / developer / assistant (no tool calls)
  return {
    role: msg.role,
    content: msg.content ?? null,
    ...(msg.name ? { name: msg.name } : {}),
  };
}

function toMessages(runtime: IAgentRuntime, params: GenerateTextParams): Record<string, unknown>[] {
  const messages: ChatMessage[] = params.messages
    ? [...params.messages]
    : [{ role: "user" as const, content: params.prompt }];
  const system = runtime.character?.system;
  const withSystem: ChatMessage[] =
    system && !messages.some((message) => message.role === "system")
      ? [{ role: "system", content: system }, ...messages]
      : messages;
  return withSystem.map(toCerebrasApiMessage);
}

/**
 * Cerebras's JSON-schema grammar compiler rejects function names that contain
 * characters outside `[a-zA-Z0-9_-]` (notably `.`, `:`, `/`, spaces). It returns
 * `400 wrong_api_format` with `param: response_format` because grammar
 * compilation runs over the tools spec when generating constrained output.
 *
 * We sanitize names on the way out and rebuild a `{sanitized → original}` map
 * so we can rewrite `tool_calls[*].function.name` on the response.
 */
const CEREBRAS_NAME_PATTERN = /[^a-zA-Z0-9_-]/g;

function sanitizeForCerebras(name: string): string {
  return name.replace(CEREBRAS_NAME_PATTERN, "_");
}

/**
 * Cerebras also rejects object schemas where `properties` is missing or empty:
 * `Object fields require at least one of: 'properties' or 'anyOf' with a list
 * of possible properties.` This breaks every parameterless tool because
 * OpenAI-compatible clients normally send `{ type: "object", properties: {} }`.
 *
 * We rewrite empty object schemas recursively into permissive ones that
 * Cerebras accepts: drop `properties` and any restrictive
 * `additionalProperties: false`. The resulting schema places no constraint on
 * the arguments object, which is the right semantic for a parameterless tool.
 */
function normalizeSchemaForCerebras(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const node = { ...(schema as Record<string, unknown>) };

  if (node.type === "object") {
    const props = node.properties;
    const hasProps = props && typeof props === "object" && Object.keys(props).length > 0;
    const hasAnyOf = Array.isArray(node.anyOf) && node.anyOf.length > 0;
    const hasOneOf = Array.isArray(node.oneOf) && node.oneOf.length > 0;
    if (!hasProps && !hasAnyOf && !hasOneOf) {
      delete node.properties;
      delete node.required;
      delete node.additionalProperties;
    } else if (hasProps) {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        next[k] = normalizeSchemaForCerebras(v);
      }
      node.properties = next;
    }
  }

  if (Array.isArray(node.anyOf)) {
    node.anyOf = node.anyOf.map(normalizeSchemaForCerebras);
  }
  if (Array.isArray(node.oneOf)) {
    node.oneOf = node.oneOf.map(normalizeSchemaForCerebras);
  }
  if (node.items) {
    node.items = normalizeSchemaForCerebras(node.items);
  }
  return node;
}

function toOpenAITool(
  tool: ToolDefinition,
  nameMap: Map<string, string>,
): Record<string, unknown> {
  const safeName = sanitizeForCerebras(tool.name);
  if (safeName !== tool.name) {
    nameMap.set(safeName, tool.name);
  }
  const rawParams = tool.parameters ?? { type: "object" };
  return {
    type: "function",
    function: {
      name: safeName,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: normalizeSchemaForCerebras(rawParams),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

function toOpenAITools(
  tools: GenerateTextParams["tools"],
  nameMap: Map<string, string>,
): Record<string, unknown>[] | undefined {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => toOpenAITool(tool, nameMap));
}

function toOpenAIToolChoice(
  toolChoice: ToolChoice | undefined,
  nameMap: Map<string, string>,
): unknown {
  if (!toolChoice) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  const maybeToolChoice = toolChoice as {
    name?: string;
    toolName?: string;
    function?: { name?: string };
  };
  const name = maybeToolChoice.name ?? maybeToolChoice.toolName ?? maybeToolChoice.function?.name;
  if (!name) {
    return toolChoice;
  }
  const safe = sanitizeForCerebras(name);
  if (safe !== name) {
    nameMap.set(safe, name);
  }
  return {
    type: "function",
    function: { name: safe },
  };
}

function toResponseFormat(params: GenerateTextParams): unknown {
  if (params.responseSchema) {
    return {
      type: "json_schema",
      json_schema: {
        name: "eliza_response",
        strict: true,
        schema: normalizeSchemaForCerebras(params.responseSchema),
      },
    };
  }

  if (!params.responseFormat) {
    return undefined;
  }

  if (typeof params.responseFormat === "string") {
    return { type: params.responseFormat };
  }
  return params.responseFormat;
}

function getPromptCacheKey(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithProviderOptions
): string | undefined {
  return (
    params.providerOptions?.cerebras?.prompt_cache_key ??
    params.providerOptions?.cerebras?.promptCacheKey ??
    params.prompt_cache_key ??
    getSetting(runtime, "CEREBRAS_PROMPT_CACHE_KEY")
  );
}

function buildRequestPayload(
  runtime: IAgentRuntime,
  model: string,
  params: GenerateTextParamsWithProviderOptions,
  nameMap: Map<string, string>
): Record<string, unknown> {
  const tools = toOpenAITools(params.tools, nameMap);
  const toolChoice = toOpenAIToolChoice(params.toolChoice, nameMap);
  // Cerebras rejects requests that combine `tools` with `response_format`
  // (grammar-constrained output is mutually exclusive with native tool calling
  // on their inference stack). When tools are present, native tool_calls in
  // the response carry the structured output, so we drop response_format.
  const responseFormat = tools ? undefined : toResponseFormat(params);
  const promptCacheKey = getPromptCacheKey(runtime, params);

  return {
    model,
    messages: toMessages(runtime, params),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.topP !== undefined ? { top_p: params.topP } : {}),
    ...(params.frequencyPenalty !== undefined
      ? { frequency_penalty: params.frequencyPenalty }
      : {}),
    ...(params.presencePenalty !== undefined ? { presence_penalty: params.presencePenalty } : {}),
    ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
  };
}

async function gzipJson(json: string): Promise<BodyInit> {
  const compression = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream;
  if (!compression) {
    throw new Error("Cerebras gzip payload encoding requires CompressionStream support");
  }
  return new Blob([json]).stream().pipeThrough(new compression("gzip"));
}

async function encodePayload(
  payload: Record<string, unknown>,
  options: CerebrasProviderOptions | undefined
): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  const encoding = options?.payloadEncoding ?? "json";
  if (encoding === "msgpack") {
    if (!options?.encodePayload) {
      throw new Error(
        "Cerebras msgpack payload encoding requires providerOptions.cerebras.encodePayload"
      );
    }
    return {
      body: await options.encodePayload(payload),
      headers: { "Content-Type": options.contentType ?? "application/msgpack" },
    };
  }

  const json = JSON.stringify(payload);
  if (encoding === "gzip") {
    return {
      body: await gzipJson(json),
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
    };
  }

  return {
    body: json,
    headers: { "Content-Type": "application/json" },
  };
}

function normalizeUsage(response: ChatCompletionResponse): TextResult["usage"] | undefined {
  const usage = response.usage;
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(cachedTokens !== undefined
      ? { cachedPromptTokens: cachedTokens, cacheReadInputTokens: cachedTokens }
      : {}),
  };
}

function normalizeToolCalls(
  choice: NonNullable<ChatCompletionResponse["choices"]>[number],
  nameMap: Map<string, string>
): ToolCall[] {
  return (choice.message?.tool_calls ?? []).map((toolCall) => {
    const sanitized = toolCall.function?.name ?? "";
    const original = nameMap.get(sanitized) ?? sanitized;
    return {
      id: toolCall.id ?? "",
      name: original,
      arguments: toolCall.function?.arguments ?? "{}",
      type: (toolCall.type as ToolCall["type"]) ?? "function",
      status: "pending",
    };
  });
}

function normalizeTextResult(
  response: ChatCompletionResponse,
  nameMap: Map<string, string>
): TextResult {
  const choice = response.choices?.[0] ?? {};
  return {
    text: choice.message?.content ?? "",
    toolCalls: normalizeToolCalls(choice, nameMap),
    finishReason: choice.finish_reason,
    usage: normalizeUsage(response),
  };
}

function createLlmCallDetails(
  model: string,
  params: GenerateTextParams,
  systemPrompt: string | undefined,
  modelType?: ModelTypeName,
  payload?: Record<string, unknown>
): RecordLlmCallDetails {
  return {
    model,
    modelType,
    provider: "cerebras",
    systemPrompt: systemPrompt ?? "",
    userPrompt: params.prompt,
    prompt: params.prompt,
    messages: params.messages,
    tools: payload?.tools ?? params.tools,
    toolChoice: payload?.tool_choice ?? params.toolChoice,
    responseSchema: params.responseSchema,
    providerOptions: params.providerOptions,
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens ?? 8192,
    purpose: "external_llm",
    actionType: "cerebras.chat.completions.create",
  };
}

function applyUsageToDetails(details: RecordLlmCallDetails, usage: TextResult["usage"]): void {
  if (!usage) {
    return;
  }
  details.promptTokens = usage.promptTokens;
  details.completionTokens = usage.completionTokens;
}

function emitModelUsed(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  model: string,
  usage: TextResult["usage"]
): void {
  if (!usage) {
    return;
  }
  void runtime.emitEvent?.(
    EventType.MODEL_USED as string,
    {
      runtime,
      source: "cerebras",
      provider: "cerebras",
      type: modelType,
      model,
      modelName: model,
      tokens: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
        ...(usage.cacheReadInputTokens !== undefined
          ? { cacheReadInputTokens: usage.cacheReadInputTokens }
          : {}),
      },
    } as never
  );
}

async function callCerebrasChatCompletions(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  model: string,
  params: GenerateTextParams
): Promise<TextResult> {
  if (params.stream) {
    throw new Error("Cerebras plugin does not yet support streaming chat completions");
  }

  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    throw new Error("CEREBRAS_API_KEY is required");
  }

  const paramsWithOptions = params as GenerateTextParamsWithProviderOptions;
  const nameMap = new Map<string, string>();
  const payload = buildRequestPayload(runtime, model, paramsWithOptions, nameMap);
  const providerOptions = paramsWithOptions.providerOptions?.cerebras;
  const encoded = await encodePayload(payload, providerOptions);
  const details = createLlmCallDetails(
    model,
    params,
    runtime.character?.system,
    modelType,
    payload
  );
  const fetchImpl = getFetch(runtime);

  const result = await recordLlmCall(runtime, details, async () => {
    const response = await fetchImpl(`${getBaseURL(runtime)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...encoded.headers,
        ...(providerOptions?.headers ?? {}),
      },
      body: encoded.body,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cerebras chat completions failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const textResult = normalizeTextResult(data, nameMap);
    details.response = textResult.text;
    details.toolCalls = textResult.toolCalls;
    details.finishReason = textResult.finishReason;
    applyUsageToDetails(details, textResult.usage);
    return textResult;
  });

  emitModelUsed(runtime, modelType, model, result.usage);
  return result;
}

async function generateTextByModelType(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName,
  getModel: (runtime: IAgentRuntime) => string
): Promise<string> {
  const result = await callCerebrasChatCompletions(runtime, modelType, getModel(runtime), params);
  return shouldReturnNativeResult(params) ? (result as unknown as string) : result.text;
}

async function generateObjectByModel(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: ModelTypeName,
  getModel: (runtime: IAgentRuntime) => string
): Promise<Record<string, JsonValue>> {
  const textParams = {
    prompt: params.prompt,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    responseSchema: params.schema ?? { type: "object" },
  } as GenerateTextParams;
  const result = await callCerebrasChatCompletions(
    runtime,
    modelType,
    getModel(runtime),
    textParams
  );
  return JSON.parse(result.text) as Record<string, JsonValue>;
}

const env = getProcessEnv();

export const cerebrasPlugin: Plugin = {
  name: "cerebras",
  description: "Cerebras direct chat-completions provider with native tools and structured outputs",

  config: {
    CEREBRAS_API_KEY: env.CEREBRAS_API_KEY ?? null,
    CEREBRAS_BASE_URL: env.CEREBRAS_BASE_URL ?? null,
    CEREBRAS_NANO_MODEL: env.CEREBRAS_NANO_MODEL ?? null,
    CEREBRAS_MEDIUM_MODEL: env.CEREBRAS_MEDIUM_MODEL ?? null,
    CEREBRAS_SMALL_MODEL: env.CEREBRAS_SMALL_MODEL ?? null,
    CEREBRAS_LARGE_MODEL: env.CEREBRAS_LARGE_MODEL ?? null,
    CEREBRAS_MEGA_MODEL: env.CEREBRAS_MEGA_MODEL ?? null,
    CEREBRAS_RESPONSE_HANDLER_MODEL: env.CEREBRAS_RESPONSE_HANDLER_MODEL ?? null,
    CEREBRAS_SHOULD_RESPOND_MODEL: env.CEREBRAS_SHOULD_RESPOND_MODEL ?? null,
    CEREBRAS_ACTION_PLANNER_MODEL: env.CEREBRAS_ACTION_PLANNER_MODEL ?? null,
    CEREBRAS_PLANNER_MODEL: env.CEREBRAS_PLANNER_MODEL ?? null,
    CEREBRAS_PROMPT_CACHE_KEY: env.CEREBRAS_PROMPT_CACHE_KEY ?? null,
    CEREBRAS_ALLOW_BROWSER_API_KEY: env.CEREBRAS_ALLOW_BROWSER_API_KEY ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
  },

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    if (!getApiKey(runtime) && !isBrowser()) {
      throw new Error("CEREBRAS_API_KEY is required");
    }
  },

  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(runtime, params, ModelType.TEXT_SMALL, getSmallModel),
    [TEXT_NANO_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(runtime, params, TEXT_NANO_MODEL_TYPE, getNanoModel),
    [TEXT_MEDIUM_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(runtime, params, TEXT_MEDIUM_MODEL_TYPE, getMediumModel),
    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(runtime, params, ModelType.TEXT_LARGE, getLargeModel),
    [TEXT_MEGA_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(runtime, params, TEXT_MEGA_MODEL_TYPE, getMegaModel),
    [RESPONSE_HANDLER_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(
        runtime,
        params,
        RESPONSE_HANDLER_MODEL_TYPE,
        getResponseHandlerModel
      ),
    [ACTION_PLANNER_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) =>
      generateTextByModelType(runtime, params, ACTION_PLANNER_MODEL_TYPE, getActionPlannerModel),
    [ModelType.OBJECT_SMALL]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) =>
      generateObjectByModel(runtime, params, ModelType.OBJECT_SMALL, getSmallModel),
    [ModelType.OBJECT_LARGE]: async (runtime: IAgentRuntime, params: ObjectGenerationParams) =>
      generateObjectByModel(runtime, params, ModelType.OBJECT_LARGE, getLargeModel),
  },

  tests: [
    {
      name: "cerebras_plugin_tests",
      tests: [
        {
          name: "cerebras_test_api_connectivity",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const apiKey = getApiKey(runtime);
            if (!apiKey) {
              throw new Error("CEREBRAS_API_KEY is required");
            }
            const response = await getFetch(runtime)(`${getBaseURL(runtime)}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (!response.ok) {
              throw new Error(
                `Cerebras API connectivity test failed: ${response.status} ${response.statusText}`
              );
            }
            logger.info("[Cerebras Test] API connected.");
          },
        },
      ],
    },
  ],
};

export default cerebrasPlugin;
