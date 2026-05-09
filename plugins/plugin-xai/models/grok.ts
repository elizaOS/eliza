import {
  EventType,
  type EventPayload,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  type ModelTypeName,
  ModelType,
  type TextEmbeddingParams,
  type TextStreamResult,
  recordLlmCall,
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

function getConfig(runtime: IAgentRuntime): GrokConfig {
  const apiKey = runtime.getSetting("XAI_API_KEY");
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("XAI_API_KEY is required");
  }

  const baseUrl = runtime.getSetting("XAI_BASE_URL");
  const smallModel = runtime.getSetting("XAI_SMALL_MODEL");
  const largeModel =
    runtime.getSetting("XAI_MODEL") || runtime.getSetting("XAI_LARGE_MODEL");
  const embeddingModel = runtime.getSetting("XAI_EMBEDDING_MODEL");

  return {
    apiKey,
    baseUrl: typeof baseUrl === "string" ? baseUrl : XAI_API_BASE,
    smallModel:
      typeof smallModel === "string" ? smallModel : DEFAULT_MODELS.small,
    largeModel:
      typeof largeModel === "string" ? largeModel : DEFAULT_MODELS.large,
    embeddingModel:
      typeof embeddingModel === "string"
        ? embeddingModel
        : DEFAULT_MODELS.embedding,
  };
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
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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
    for (const [name, value] of Object.entries(tools as Record<string, XaiToolDefinition>)) {
      const normalized = normalizeXaiTool({ ...value, name });
      if (normalized) out.push(normalized);
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function normalizeXaiTool(tool: XaiToolDefinition): Record<string, unknown> | undefined {
  const name = tool.name ?? tool.function?.name;
  if (!name) return undefined;
  const description = tool.description ?? tool.function?.description;
  const parameters =
    tool.parameters ?? tool.function?.parameters ?? tool.inputSchema ?? { type: "object" };
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
    (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required")
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
  const promptText = params.prompt ?? "";
  const tools = normalizeXaiTools(paramsWithNative.tools);
  const toolChoice = normalizeXaiToolChoice(paramsWithNative.toolChoice);
  const responseFormat = buildXaiResponseFormat(paramsWithNative.responseSchema);
  const returnNative = Boolean(
    paramsWithNative.messages ||
      paramsWithNative.tools ||
      paramsWithNative.toolChoice ||
      paramsWithNative.responseSchema,
  );

  const messages: ChatMessage[] = paramsWithNative.messages?.length
    ? (paramsWithNative.messages as ChatMessage[])
    : [{ role: "user", content: promptText }];

  const body: Record<string, unknown> = {
    model,
    messages,
  };

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens;
  }
  if (params.stopSequences) {
    body.stop = params.stopSequences;
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
    body.stream = true;
    const onStreamChunk = params.onStreamChunk;

    return recordLlmCall(
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
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
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
        let fullText = "";
        let usage: NormalizedUsage | null = null;
        let responseModel = model;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            const parsed = JSON.parse(data) as StreamCompletionChunk;
            const chunkUsage = normalizeTokenUsage(parsed.usage);
            if (chunkUsage) {
              usage = chunkUsage;
            }
            if (typeof parsed.model === "string" && parsed.model.length > 0) {
              responseModel = parsed.model;
            }

            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              onStreamChunk(content);
            }
          }
        }

        emitModelUsed(
          runtime,
          modelType,
          responseModel,
          usage ?? estimateUsage(promptText, fullText),
        );
        return fullText;
      },
    );
  }

  return recordLlmCall(
    runtime,
    {
      model,
      systemPrompt: "",
      userPrompt: promptText,
      temperature: params.temperature ?? 0,
      maxTokens: params.maxTokens ?? 0,
      purpose: "external_llm",
      actionType: "xai.chat.completions.create",
    },
    async () => {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: getAuthHeader(config),
        body: JSON.stringify(body),
      });

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

function parseJsonOrRaw(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function createEmbedding(
  runtime: IAgentRuntime,
  config: GrokConfig,
  text: string,
): Promise<number[]> {
  const response = await fetch(`${config.baseUrl}/embeddings`, {
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

  if (!data.data?.[0]?.embedding) {
    throw new Error("No embedding in Grok response");
  }

  emitModelUsed(
    runtime,
    ModelType.TEXT_EMBEDDING,
    data.model || config.embeddingModel,
    normalizeTokenUsage(data.usage) ?? estimateEmbeddingUsage(text),
  );
  return data.data[0].embedding;
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
  if (params === null) {
    throw new Error("Null params provided for embedding");
  }
  const config = getConfig(runtime);
  const text =
    typeof params === "string" ? params : (params as TextEmbeddingParams).text;
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
  return !!runtime.getSetting("XAI_API_KEY");
}
