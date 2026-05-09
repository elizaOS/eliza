import { createGroq } from "@ai-sdk/groq";
import type {
  EventPayload,
  IAgentRuntime,
  ModelTypeName,
  Plugin,
  RecordLlmCallDetails,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  EventType,
  type GenerateTextParams,
  logger,
  ModelType,
  recordLlmCall,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import {
  APICallError,
  generateText,
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  Output,
  type ToolChoice,
  type ToolSet,
} from "ai";

const _globalThis = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: boolean;
};
_globalThis.AI_SDK_LOG_WARNINGS ??= false;
const DEFAULT_SMALL_MODEL = "openai/gpt-oss-20b";
const DEFAULT_LARGE_MODEL = "openai/gpt-oss-120b";
const DEFAULT_TTS_MODEL = "canopylabs/orpheus-v1-english";
const DEFAULT_TTS_VOICE = "autumn";
const DEFAULT_TTS_RESPONSE_FORMAT = "wav";
const DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

function resolveGroqSystemPrompt(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): string | undefined {
  return resolveEffectiveSystemPrompt({
    params,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
}

function resolveGroqPrompt(params: GenerateTextParams, systemPrompt: string | undefined): string {
  return (
    renderChatMessagesForPrompt(params.messages, {
      omitDuplicateSystem: systemPrompt,
    }) ??
    params.prompt ??
    ""
  );
}

type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

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

  const record = usage as ProviderUsage;
  const promptTokens = toFiniteNumber(record.inputTokens ?? record.promptTokens);
  const completionTokens = toFiniteNumber(record.outputTokens ?? record.completionTokens);
  const totalTokens = toFiniteNumber(record.totalTokens);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return null;
  }

  const normalizedPromptTokens =
    promptTokens ??
    (completionTokens === undefined && totalTokens !== undefined
      ? totalTokens
      : Math.max(0, (totalTokens ?? 0) - (completionTokens ?? 0)));
  const normalizedCompletionTokens =
    completionTokens ??
    Math.max(0, (totalTokens ?? normalizedPromptTokens) - normalizedPromptTokens);

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: totalTokens ?? normalizedPromptTokens + normalizedCompletionTokens,
  };
}

function applyUsageToDetails(details: RecordLlmCallDetails, usage: unknown): void {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) {
    return;
  }
  details.promptTokens = normalized.promptTokens;
  details.completionTokens = normalized.completionTokens;
}

function estimateTokenCount(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function stringifyForUsage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateUsage(prompt: string, response: unknown): NormalizedUsage {
  const promptTokens = estimateTokenCount(prompt);
  const completionTokens = estimateTokenCount(stringifyForUsage(response));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function emitModelUsed(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  model: string,
  usage: NormalizedUsage
): void {
  void runtime.emitEvent(
    EventType.MODEL_USED as string,
    {
      runtime,
      source: "groq",
      provider: "groq",
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
    } as EventPayload
  );
}

function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

function getBaseURL(runtime: IAgentRuntime): string {
  const url = runtime.getSetting("GROQ_BASE_URL");
  return typeof url === "string" ? url : DEFAULT_BASE_URL;
}

function getSmallModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL");
  return typeof setting === "string" ? setting : DEFAULT_SMALL_MODEL;
}

function getNanoModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_NANO_MODEL") || runtime.getSetting("NANO_MODEL");
  return typeof setting === "string" ? setting : getSmallModel(runtime);
}

function getMediumModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_MEDIUM_MODEL") || runtime.getSetting("MEDIUM_MODEL");
  return typeof setting === "string" ? setting : getSmallModel(runtime);
}

function getLargeModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL");
  return typeof setting === "string" ? setting : DEFAULT_LARGE_MODEL;
}

function getMegaModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_MEGA_MODEL") || runtime.getSetting("MEGA_MODEL");
  return typeof setting === "string" ? setting : getLargeModel(runtime);
}

function getResponseHandlerModel(runtime: IAgentRuntime): string {
  const setting =
    runtime.getSetting("GROQ_RESPONSE_HANDLER_MODEL") ||
    runtime.getSetting("GROQ_SHOULD_RESPOND_MODEL") ||
    runtime.getSetting("RESPONSE_HANDLER_MODEL") ||
    runtime.getSetting("SHOULD_RESPOND_MODEL");
  return typeof setting === "string" ? setting : getNanoModel(runtime);
}

function getActionPlannerModel(runtime: IAgentRuntime): string {
  const setting =
    runtime.getSetting("GROQ_ACTION_PLANNER_MODEL") ||
    runtime.getSetting("GROQ_PLANNER_MODEL") ||
    runtime.getSetting("ACTION_PLANNER_MODEL") ||
    runtime.getSetting("PLANNER_MODEL");
  // Action planning is a reasoning-heavy task — route to the LARGE tier by
  // default (gpt-oss-120b) rather than the SMALL/MEDIUM tier. Small models
  // mis-classify semantically adjacent actions too often to be the default.
  return typeof setting === "string" ? setting : getLargeModel(runtime);
}

function createGroqClient(runtime: IAgentRuntime) {
  // In browsers, default to *not* sending secrets.
  // Use a server-side proxy and configure GROQ_BASE_URL (or explicitly opt-in).
  const allowBrowserKey =
    !isBrowser() ||
    String(runtime.getSetting("GROQ_ALLOW_BROWSER_API_KEY") ?? "").toLowerCase() === "true";
  const apiKey = allowBrowserKey ? runtime.getSetting("GROQ_API_KEY") : undefined;
  return createGroq({
    apiKey: typeof apiKey === "string" ? apiKey : undefined,
    fetch: runtime.fetch ?? undefined,
    baseURL: getBaseURL(runtime),
  });
}

function extractRetryDelay(message: string): number {
  const match = message.match(/try again in (\d+\.?\d*)s/i);
  if (match?.[1]) {
    return Math.ceil(Number.parseFloat(match[1]) * 1000) + 1000;
  }
  return 10000;
}

/**
 * Classify an error thrown by `generateText`/`generateObject`. The AI SDK
 * already retries transient 5xx and network failures up to `maxRetries`
 * times with exponential backoff (~2s, 4s, 8s). This outer layer only kicks
 * in when the AI SDK gives up — typically for 429 rate limits whose
 * server-suggested cooldown (often 30–60s) exceeds the AI SDK's budget.
 *
 * Returns `"rate-limit"` for 429s (where we honor `try again in Ns`),
 * `"transient"` for 5xx / network failures worth one more shot, and
 * `"fatal"` for auth / validation / unknown errors that should propagate
 * immediately.
 */
export function classifyRetryError(error: unknown): "rate-limit" | "transient" | "fatal" {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "rate-limit";
    if (typeof error.statusCode === "number" && error.statusCode >= 500 && error.statusCode < 600) {
      return "transient";
    }
    if (error.isRetryable) return "transient";
    return "fatal";
  }

  if (!(error instanceof Error)) return "fatal";

  const message = error.message.toLowerCase();
  if (
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("too many requests") ||
    /try again in \d/i.test(error.message)
  ) {
    return "rate-limit";
  }
  // Node fetch / undici transient network failures.
  if (
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("network error") ||
    message.includes("fetch failed")
  ) {
    return "transient";
  }
  return "fatal";
}

type NativeOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;

function buildGroqStructuredOutput(responseSchema: unknown): NativeOutput {
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
    schema: jsonSchema(schemaOptions.schema as JSONSchema7),
    ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
    ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
  }) as NativeOutput;
}

type GroqUsage = {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

interface GroqNativeTextResult {
  text: string;
  toolCalls: unknown[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

function buildGroqNativeTextResult(result: {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: GroqUsage;
}): GroqNativeTextResult {
  const inputTokens = result.usage?.inputTokens ?? result.usage?.promptTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? result.usage?.completionTokens ?? 0;
  const usage = result.usage
    ? {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
      }
    : undefined;
  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    ...(usage ? { usage } : {}),
  };
}

async function generateWithRetry(
  runtime: IAgentRuntime,
  groq: ReturnType<typeof createGroq>,
  modelType: ModelTypeName,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
    messages?: ModelMessage[];
    tools?: ToolSet;
    toolChoice?: ToolChoice<ToolSet>;
    responseSchema?: unknown;
    returnNative?: boolean;
  }
): Promise<string | GroqNativeTextResult> {
  const generate = () => {
    const details: RecordLlmCallDetails = {
      model,
      systemPrompt: params.system ?? "",
      userPrompt: params.prompt,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      purpose: "external_llm",
      actionType: "ai.generateText",
    };

    return recordLlmCall(runtime, details, async () => {
      // Native tool calling + structured output: when callers pass `tools`,
      // `toolChoice`, `responseSchema`, or `messages`, route through the AI
      // SDK's native shape (Groq's OpenAI-compatible chat.completions API
      // accepts `tools`, `tool_choice`, and `response_format` for JSON mode).
      // When only `prompt` is supplied, fall back to the simple generate-text
      // shape — this keeps caching/cost flow untouched for the common path.
      const sharedSettings = {
        model: groq.languageModel(model),
        system: params.system,
        temperature: params.temperature,
        maxRetries: 3,
        frequencyPenalty: params.frequencyPenalty,
        presencePenalty: params.presencePenalty,
        stopSequences: params.stopSequences,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
        ...(params.responseSchema
          ? { output: buildGroqStructuredOutput(params.responseSchema) }
          : {}),
      };
      const result =
        params.messages && params.messages.length > 0
          ? await generateText({ ...sharedSettings, messages: params.messages })
          : await generateText({ ...sharedSettings, prompt: params.prompt });
      details.response = result.text;
      applyUsageToDetails(details, result.usage);
      return result;
    });
  };

  const MAX_RATE_LIMIT_RETRIES = 5;
  const MAX_TRANSIENT_RETRIES = 2;
  let rateLimitAttempts = 0;
  let transientAttempts = 0;

  while (true) {
    try {
      const result = await generate();
      const usage = normalizeTokenUsage(result.usage) ?? estimateUsage(params.prompt, result.text);
      emitModelUsed(runtime, modelType, model, usage);
      if (params.returnNative) {
        return buildGroqNativeTextResult(result);
      }
      const { text } = result;
      return text;
    } catch (error) {
      const kind = classifyRetryError(error);

      if (kind === "rate-limit" && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
        const message = error instanceof Error ? error.message : String(error);
        // Respect the server-suggested wait, then add exponential jitter on
        // top so multiple parallel callers don't re-collide on the same
        // window boundary.
        const hinted = extractRetryDelay(message);
        const backoff = Math.min(30_000, 500 * 2 ** rateLimitAttempts);
        const delay = hinted + backoff;
        rateLimitAttempts += 1;
        logger.warn(
          `Groq rate limit hit (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}), retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (kind === "transient" && transientAttempts < MAX_TRANSIENT_RETRIES) {
        // AI SDK already retried with exponential backoff; use a small fixed
        // backoff with jitter here to smooth over post-exhaustion flakiness.
        const delay = 1_000 + Math.floor(Math.random() * 1_500);
        transientAttempts += 1;
        logger.warn(
          `Groq transient failure (attempt ${transientAttempts}/${MAX_TRANSIENT_RETRIES}), retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }
}

function buildGroqGenerateParams(
  params: GenerateTextParams,
  systemPrompt: string | undefined,
  promptText: string
): {
  prompt: string;
  system?: string;
  temperature: number;
  maxTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  stopSequences: string[];
  messages?: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  responseSchema?: unknown;
  returnNative?: boolean;
} {
  const paramsWithNative = params as GenerateTextParams & {
    messages?: ModelMessage[];
    tools?: ToolSet;
    toolChoice?: ToolChoice<ToolSet>;
    responseSchema?: unknown;
  };
  const returnNative = Boolean(
    paramsWithNative.messages ||
      paramsWithNative.tools ||
      paramsWithNative.toolChoice ||
      paramsWithNative.responseSchema
  );
  return {
    prompt: promptText,
    system: systemPrompt,
    temperature: params.temperature ?? 0.7,
    maxTokens: params.maxTokens ?? 8192,
    frequencyPenalty: params.frequencyPenalty ?? 0.7,
    presencePenalty: params.presencePenalty ?? 0.7,
    stopSequences: params.stopSequences || [],
    ...(paramsWithNative.messages ? { messages: paramsWithNative.messages } : {}),
    ...(paramsWithNative.tools ? { tools: paramsWithNative.tools } : {}),
    ...(paramsWithNative.toolChoice ? { toolChoice: paramsWithNative.toolChoice } : {}),
    ...(paramsWithNative.responseSchema ? { responseSchema: paramsWithNative.responseSchema } : {}),
    ...(returnNative ? { returnNative } : {}),
  };
}

async function handleTextModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: ModelTypeName
): Promise<string> {
  const groq = createGroqClient(runtime);
  const model = getTextModelForType(runtime, modelType);
  const system = resolveGroqSystemPrompt(runtime, params);
  const result = await generateWithRetry(
    runtime,
    groq,
    modelType,
    model,
    buildGroqGenerateParams(params, system, resolveGroqPrompt(params, system))
  );
  // Native result (with toolCalls / usage / finishReason) is cast through the
  // string return type because elizaOS's plugin Model handler signature is
  // `(runtime, params) => Promise<string | TextStreamResult>`. The runtime
  // unwraps the native shape via `useModel` consumers that pass `tools` /
  // `messages` / `responseSchema` / `toolChoice`.
  return result as string;
}

function getTextModelForType(runtime: IAgentRuntime, modelType: string): string {
  switch (modelType) {
    case ModelType.TEXT_NANO:
      return getNanoModel(runtime);
    case ModelType.TEXT_MEDIUM:
      return getMediumModel(runtime);
    case ModelType.TEXT_SMALL:
      return getSmallModel(runtime);
    case ModelType.TEXT_LARGE:
      return getLargeModel(runtime);
    case ModelType.TEXT_MEGA:
      return getMegaModel(runtime);
    case ModelType.RESPONSE_HANDLER:
      return getResponseHandlerModel(runtime);
    case ModelType.ACTION_PLANNER:
      return getActionPlannerModel(runtime);
    default:
      return getLargeModel(runtime);
  }
}

export const groqPlugin: Plugin = {
  name: "groq",
  description: "Groq LLM provider - fast inference with Llama and other models",
  autoEnable: {
    envKeys: ["GROQ_API_KEY"],
  },

  config: {
    GROQ_API_KEY: typeof process !== "undefined" ? (process.env.GROQ_API_KEY ?? null) : null,
    GROQ_BASE_URL: typeof process !== "undefined" ? (process.env.GROQ_BASE_URL ?? null) : null,
    GROQ_NANO_MODEL: typeof process !== "undefined" ? (process.env.GROQ_NANO_MODEL ?? null) : null,
    GROQ_MEDIUM_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_MEDIUM_MODEL ?? null) : null,
    GROQ_SMALL_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_SMALL_MODEL ?? null) : null,
    GROQ_LARGE_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_LARGE_MODEL ?? null) : null,
    GROQ_MEGA_MODEL: typeof process !== "undefined" ? (process.env.GROQ_MEGA_MODEL ?? null) : null,
    GROQ_RESPONSE_HANDLER_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_RESPONSE_HANDLER_MODEL ?? null) : null,
    GROQ_SHOULD_RESPOND_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_SHOULD_RESPOND_MODEL ?? null) : null,
    GROQ_ACTION_PLANNER_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_ACTION_PLANNER_MODEL ?? null) : null,
    GROQ_PLANNER_MODEL:
      typeof process !== "undefined" ? (process.env.GROQ_PLANNER_MODEL ?? null) : null,
    NANO_MODEL: typeof process !== "undefined" ? (process.env.NANO_MODEL ?? null) : null,
    MEDIUM_MODEL: typeof process !== "undefined" ? (process.env.MEDIUM_MODEL ?? null) : null,
    SMALL_MODEL: typeof process !== "undefined" ? (process.env.SMALL_MODEL ?? null) : null,
    LARGE_MODEL: typeof process !== "undefined" ? (process.env.LARGE_MODEL ?? null) : null,
    MEGA_MODEL: typeof process !== "undefined" ? (process.env.MEGA_MODEL ?? null) : null,
    RESPONSE_HANDLER_MODEL:
      typeof process !== "undefined" ? (process.env.RESPONSE_HANDLER_MODEL ?? null) : null,
    SHOULD_RESPOND_MODEL:
      typeof process !== "undefined" ? (process.env.SHOULD_RESPOND_MODEL ?? null) : null,
    ACTION_PLANNER_MODEL:
      typeof process !== "undefined" ? (process.env.ACTION_PLANNER_MODEL ?? null) : null,
    PLANNER_MODEL: typeof process !== "undefined" ? (process.env.PLANNER_MODEL ?? null) : null,
  },

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    const apiKey = runtime.getSetting("GROQ_API_KEY");
    if (!apiKey && !isBrowser()) {
      throw new Error("GROQ_API_KEY is required");
    }
  },

  models: {
    [ModelType.TEXT_NANO]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.TEXT_NANO),

    [ModelType.TEXT_SMALL]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.TEXT_SMALL),

    [ModelType.TEXT_MEDIUM]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.TEXT_MEDIUM),

    [ModelType.TEXT_LARGE]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.TEXT_LARGE),

    [ModelType.TEXT_MEGA]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.TEXT_MEGA),

    [ModelType.RESPONSE_HANDLER]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.RESPONSE_HANDLER),

    [ModelType.ACTION_PLANNER]: (runtime, params: GenerateTextParams) =>
      handleTextModel(runtime, params, ModelType.ACTION_PLANNER),

    [ModelType.TRANSCRIPTION]: async (runtime, params) => {
      type AudioDataShape = { audioData: Uint8Array };

      function hasAudioData(obj: object): obj is AudioDataShape {
        return "audioData" in obj && (obj as AudioDataShape).audioData instanceof Uint8Array;
      }

      if (isBrowser()) {
        throw new Error(
          "Groq TRANSCRIPTION is not supported directly in browsers. Use a server proxy or submit a Blob/ArrayBuffer to a server."
        );
      }

      const hasBuffer =
        typeof Buffer !== "undefined" &&
        typeof (Buffer as { isBuffer: (v: unknown) => boolean }).isBuffer === "function";

      const audioBuffer: Buffer =
        typeof params === "string"
          ? Buffer.from(params, "base64")
          : hasBuffer &&
              (Buffer as { isBuffer: (v: unknown) => boolean }).isBuffer(params)
            ? (params as Buffer)
            : typeof params === "object" && params !== null && hasAudioData(params)
              ? Buffer.from((params as AudioDataShape).audioData)
              : Buffer.alloc(0);
      const baseURL = getBaseURL(runtime);
      const formData = new FormData();
      formData.append(
        "file",
        new File([audioBuffer as BlobPart], "audio.mp3", { type: "audio/mp3" })
      );
      formData.append("model", DEFAULT_TRANSCRIPTION_MODEL);

      const apiKey = runtime.getSetting("GROQ_API_KEY");
      const details: RecordLlmCallDetails = {
        model: DEFAULT_TRANSCRIPTION_MODEL,
        systemPrompt: "",
        userPrompt: `audio transcription request: ${audioBuffer.byteLength} bytes`,
        temperature: 0,
        maxTokens: 0,
        purpose: "external_llm",
        actionType: "groq.audio.transcriptions.create",
      };
      const data = await recordLlmCall(runtime, details, async () => {
        const response = await fetch(`${baseURL}/audio/transcriptions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${typeof apiKey === "string" ? apiKey : ""}`,
          },
          body: formData,
        });

        if (!response.ok) {
          throw new Error(`Transcription failed: ${response.status} ${await response.text()}`);
        }

        const result = (await response.json()) as { text: string };
        details.response = result.text;
        return result;
      });
      return data.text;
    },

    [ModelType.TEXT_TO_SPEECH]: async (runtime: IAgentRuntime, params) => {
      if (isBrowser()) {
        throw new Error(
          "Groq TEXT_TO_SPEECH is not supported directly in browsers. Use a server proxy."
        );
      }
      const payload =
        typeof params === "string"
          ? { text: params }
          : (params as {
              text?: string;
              voice?: string;
              model?: string;
              responseFormat?: string;
              response_format?: string;
            });
      const text = typeof payload.text === "string" ? payload.text : "";
      const baseURL = getBaseURL(runtime);
      const modelSetting = runtime.getSetting("GROQ_TTS_MODEL");
      const voiceSetting = runtime.getSetting("GROQ_TTS_VOICE");
      const responseFormatSetting = runtime.getSetting("GROQ_TTS_RESPONSE_FORMAT");
      const model =
        typeof payload.model === "string" && payload.model
          ? payload.model
          : typeof modelSetting === "string"
            ? modelSetting
            : DEFAULT_TTS_MODEL;
      const voice =
        typeof payload.voice === "string" && payload.voice
          ? payload.voice
          : typeof voiceSetting === "string"
            ? voiceSetting
            : DEFAULT_TTS_VOICE;
      const responseFormat =
        typeof payload.responseFormat === "string" && payload.responseFormat
          ? payload.responseFormat
          : typeof payload.response_format === "string" && payload.response_format
            ? payload.response_format
            : typeof responseFormatSetting === "string"
              ? responseFormatSetting
              : DEFAULT_TTS_RESPONSE_FORMAT;

      const apiKey = runtime.getSetting("GROQ_API_KEY");
      const details: RecordLlmCallDetails = {
        model,
        systemPrompt: "",
        userPrompt: text,
        temperature: 0,
        maxTokens: 0,
        purpose: "external_llm",
        actionType: "groq.audio.speech.create",
      };
      const arrayBuffer = await recordLlmCall(runtime, details, async () => {
        const response = await fetch(`${baseURL}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${typeof apiKey === "string" ? apiKey : ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            voice,
            input: text,
            response_format: responseFormat,
          }),
        });

        if (!response.ok) {
          throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
        }

        const result = await response.arrayBuffer();
        details.response = `[audio bytes=${result.byteLength} format=${responseFormat}]`;
        return result;
      });
      return new Uint8Array(arrayBuffer);
    },
  },

  tests: [
    {
      name: "groq_plugin_tests",
      tests: [
        {
          name: "validate_api_key",
          fn: async (runtime) => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: {
                Authorization: `Bearer ${runtime.getSetting("GROQ_API_KEY")}`,
              },
            });
            if (!response.ok) {
              throw new Error(`API key validation failed: ${response.statusText}`);
            }
            const data = (await response.json()) as {
              data: Array<{ id: string; owned_by: string }>;
            };
            logger.info(`Groq API validated, ${data.data.length} models available`);
          },
        },
        {
          name: "text_small",
          fn: async (runtime) => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 3 words.",
            });
            if (!text || text.length === 0) {
              throw new Error("Empty response from TEXT_SMALL");
            }
            logger.info("TEXT_SMALL:", text);
          },
        },
        {
          name: "text_large",
          fn: async (runtime) => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "What is 2+2? Answer with just the number.",
            });
            if (!text || text.length === 0) {
              throw new Error("Empty response from TEXT_LARGE");
            }
            logger.info("TEXT_LARGE:", text);
          },
        },
      ],
    },
  ],
};

export default groqPlugin;
