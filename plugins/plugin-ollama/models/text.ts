/**
 * Ollama text generation for ElizaOS.
 *
 * ## Why this module is shaped this way
 *
 * - **Single AI SDK surface:** We call **`generateText`** and **`streamText`** from `ai` so
 *   Eliza stays aligned with other provider plugins (OpenAI, OpenRouter). That avoids bespoke
 *   HTTP clients here.
 *
 * - **`ollama-ai-provider-v2`:** Older `ollama-ai-provider` exposed AI SDK model spec v1;
 *   current `ai` requires v2+ and threw `Unsupported model version v1` for every model.
 *   v2 implements the same contract as the rest of the ecosystem.
 *
 * - **`responseSchema`:** Core passes JSON Schema (or a full output spec) for pipelines
 *   that need parseable objects (e.g. FACT_EXTRACTOR). We map that to `Output.object` so
 *   Ollama receives `format: json` / schema in the wire protocol—without this, those calls
 *   failed and memory/planner features degraded under Ollama-only setups.
 *
 * - **`OLLAMA_DISABLE_STRUCTURED_OUTPUT`:** Some local models return invalid JSON or error
 *   on `format`. Stripping `responseSchema` keeps the agent running; callers may fail
 *   validation—that is intentional so operators can recover without redeploying code.
 *
 * - **Native tools / `toolChoice`:** v5 `RESPONSE_HANDLER` passes `messages`, `tools`, and
 *   `toolChoice: "required"` (see `runV5MessageRuntimeStage1`). With **`stream: false`** (or no
 *   streaming context), we use **`generateText`** and cast a `GenerateTextResult`-shaped payload
 *   when needed. With **`stream: true`** and a **tool set**, we use **`streamText`** (see
 *   **`buildOllamaStreamWithToolsResult`**). Either way matches OpenRouter/OpenAI so
 *   **`parseMessageHandlerNativeToolCall`** / **`parseMessageHandlerOutput`** can read the plan.
 *   If both tools and `responseSchema` are present, tools win (schema is omitted for that request).
 *
 * - **Stop sequences:** Empty `stopSequences` arrays are omitted on the wire (same idea as
 *   OpenRouter) so we do not send meaningless `[]` to the model.
 *
 * - **Streaming:** When `stream: true` and there is **no** `responseSchema`, **tools**, or
 *   `toolChoice`, we call **`streamText`** and return **`TextStreamResult`** so `useModel` can
 *   forward chunks to SSE callbacks. **Why:** core sets `stream` from chat context; without a
 *   stream object the runtime never invokes `onStreamChunk` and the UI shows empty replies.
 * - **`streamText` + tools:** When `stream: true` and native **tools** are present, we call
 *   **`streamText`** (same as OpenAI/OpenRouter) so Ollama streams over `/api/chat`. For
 *   **`RESPONSE_HANDLER`** / **`ACTION_PLANNER`**, `useModel`’s streaming branch concatenates
 *   **`textStream`** into the string passed to **`parseMessageHandlerOutput`** — so we **drain**
 *   the model’s text deltas internally and **yield a single trailing chunk** of the first tool’s
 *   arguments JSON (the v5 plan payload). **Why:** mixing arbitrary streamed text with that JSON
 *   would make `JSON.parse` fail on the accumulated `fullText`. Other model types forward every
 *   text chunk as usual.
 * - **Errors during `textStream`:** Failures often surface while **core** iterates **`textStream`**
 *   (after the handler returned), so they bypass **`handleTextWithModelType`’s** outer **`try`/`catch`**.
 *   **`logOllamaTextFailure`** runs inside the stream wrapper so logs still include **`ollamaResponseBody`**
 *   (Ollama’s JSON error, e.g. insufficient RAM) and the request URL. **Why:** otherwise the process
 *   exits with a generic “Internal Server Error” and operators cannot see Ollama’s message.
 * - **`stream: true` + `responseSchema` (no tools):** Still **`generateText`** only — we **log at
 *   debug** because `ollama-ai-provider-v2` does not combine structured `format: json` with the
 *   `streamText` path reliably for nested extractors (e.g. `FACT_EXTRACTOR`).
 *
 * - **`stream: true` + `toolChoice` without tools:** **`generateText`** only — we **log at debug**.
 *   **Why:** `streamText` in this adapter is only used when a **`ToolSet`** is present; `toolChoice`
 *   alone is not a supported streaming request shape. Core v5 always passes tools with Stage 1
 *   `toolChoice`; the log helps custom callers spot a bad param combo.
 *
 * - **`shouldReturnNative`:** Computed only after the final `outputSpec` (structured output)
 *   vs tools conflict is resolved, from `hasChatMessages`, `tools`, `toolChoice`, and whether
 *   structured output is still active. **Why:** the non-streaming return shape must match what we
 *   actually sent on the wire (`generateText` or the completed stream) so callers do not think
 *   they got schema-backed JSON when tools won.
 *
 * - **Usage fallback:** When the chat-messages path is used, token usage estimation uses a
 *   JSON serialization of `messages` instead of re-rendering the prompt string. **Why:** we
 *   skip `renderChatMessagesForPrompt` on that path for efficiency; usage is still best-effort
 *   when the provider omits `usage`.
 *
 * - **`providerOptions`:** Not forwarded into `generateText` yet. **Why:** Ollama’s provider
 *   surface differs from Anthropic/OpenAI cache hints; forwarding blindly could send unsupported
 *   fields. Documented in README until explicitly mapped.
 */

import type {
  GenerateTextParams,
  GenerateTextResult,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
  ToolCall,
  TokenUsage,
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
  Output,
  streamText,
} from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import {
  getActionPlannerModel,
  getBaseURL,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
  isOllamaStructuredOutputDisabled,
} from "../utils/config";
import {
  mapAiSdkToolCallsToCore,
  normalizeNativeMessages,
  normalizeNativeTools,
  normalizeToolChoice,
} from "../utils/ai-sdk-wire";
import { emitModelUsed, estimateUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { ensureModelAvailable } from "./availability";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

type GenerateTextParamsWithNativeOptions = Omit<GenerateTextParams, "responseSchema"> & {
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  /** Core passes JSON Schema objects or full AI SDK output specs; typed loosely here for Ollama. */
  responseSchema?: unknown;
};

type NativeTextOutput = NonNullable<Parameters<typeof generateText>[0]["output"]>;

/**
 * Pulls useful fields from Vercel AI SDK errors (`APICallError`, `RetryError`, `NoOutputGeneratedError`, …).
 * **Why:** the default `logger.error({ error })` serialization often hides **`responseBody`** (Ollama’s JSON
 * error string, e.g. OOM) and **`url`**, so operators only see “Internal Server Error”.
 */
function summarizeAiSdkErrorForLogs(error: unknown, depth = 0): Record<string, unknown> {
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
  if (typeof e.reason === "string") out.reason = e.reason;
  if (typeof e.url === "string") out.requestUrl = e.url;
  if (typeof e.statusCode === "number") out.httpStatus = e.statusCode;
  if (typeof e.responseBody === "string") out.ollamaResponseBody = e.responseBody;
  if (Array.isArray(e.errors)) {
    out.attemptErrors = e.errors.map((sub, i) => ({
      attempt: i + 1,
      ...summarizeAiSdkErrorForLogs(sub, depth + 1),
    }));
  }
  if (e.cause != null && typeof e.cause === "object") {
    out.cause = summarizeAiSdkErrorForLogs(e.cause, depth + 1);
  }
  return out;
}

function logOllamaTextFailure(
  phase: "generateText" | "streamText.textStream",
  modelType: string,
  modelId: string,
  endpoint: string,
  error: unknown
): void {
  logger.error(
    {
      src: "plugin:ollama:text",
      phase,
      modelType,
      modelId,
      ollamaApiEndpoint: endpoint,
      ...summarizeAiSdkErrorForLogs(error),
    },
    `[Ollama] ${phase} failed (${modelType}, model=${modelId}). See ollamaResponseBody / attemptErrors for Ollama’s JSON (e.g. insufficient RAM, model missing).`
  );
}

/**
 * Builds the AI SDK `output` spec for structured generation.
 * Why accept a pre-built object: some tests/advanced callers pass a full output descriptor
 * (`responseFormat` + `parseCompleteOutput`); otherwise we wrap JSON Schema with `Output.object`.
 */
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

/**
 * Eliza `useModel` returns a string for text types. The AI SDK may place parsed JSON in
 * `result.output` or leave JSON in `result.text`. Why stringify objects: downstream parsers
 * (e.g. FACT_EXTRACTOR) accept either a string slice or a plain object; a single JSON string
 * keeps the handler contract simple and matches older provider behavior.
 */
function serializeStructuredGenerateTextResult(result: { text: string; output: unknown }): string {
  if (result.output !== undefined && result.output !== null) {
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  }
  const trimmed = result.text?.trim() ?? "";
  if (trimmed) return trimmed;
  throw new Error("[Ollama] Structured generation returned no text or output.");
}

/**
 * Builds the object core’s v5 parsers read from `useModel` when the call used tools/messages
 * without structured `output`. Runtime value is a `GenerateTextResult`; TypeScript still types
 * the handler as `string` for historical reasons—same pattern as OpenRouter/OpenAI.
 *
 * **`providerMetadata.modelName`:** Lets trajectory / debug code attribute the call without
 * parsing Ollama response bodies again.
 */
function buildNativeResultCast(
  result: Awaited<ReturnType<typeof generateText>>,
  modelName: string,
  usage: TokenUsage
): string {
  const payload: GenerateTextResult = {
    text: result.text,
    toolCalls: mapAiSdkToolCallsToCore(result.toolCalls as unknown[] | undefined),
    finishReason: String(result.finishReason ?? ""),
    usage,
    providerMetadata: { modelName },
  };
  return payload as unknown as string;
}

type StreamTextParams = Parameters<typeof streamText>[0];

/**
 * Plain streaming path for Ollama (`streamText` from the AI SDK).
 *
 * **When:** `params.stream` is true and the request has no structured `output`, tools, or
 * `toolChoice`.
 *
 * **Why this exists:** `AgentRuntime.useModel` only forwards token chunks to SSE when the
 * handler return value satisfies **`isTextStreamResult`** (`textStream`, `text`, `usage`,
 * `finishReason` — see `packages/core/src/runtime.ts`). A bare **`string`** skips that branch:
 * the model still runs, but the UI gets no chunks (“no streamed text”).
 *
 * **Usage / `MODEL_USED`:** We resolve **`streamResult.usage`** after the stream completes,
 * merge with **`streamResult.text`** for fallback estimation, then **`emitModelUsed`** once.
 * **Why await `text` inside the usage hook:** Ollama may omit partial usage until the full
 * completion is known; pairing with final text keeps estimates sane when the provider omits
 * token fields.
 *
 * **`textStream` wrapper:** The async generator forwards chunks and, on successful completion,
 * awaits **`usagePromise`** in a **`finally`** block so consumers that only drain **`textStream`**
 * still trigger accounting—mirroring **`plugin-openrouter`**’s pattern.
 */
function buildOllamaStreamTextResult(args: {
  runtime: IAgentRuntime;
  modelType: TextModelType;
  model: string;
  /** Resolved `OLLAMA_API_ENDPOINT` — logged when `textStream` fails (errors often happen here, outside `handleTextWithModelType`’s try/catch). */
  endpoint: string;
  streamParams: StreamTextParams;
  promptForEstimate: string;
}): TextStreamResult {
  const streamResult = streamText(args.streamParams);
  const textPromise = Promise.resolve(streamResult.text);
  const finishReasonPromise = Promise.resolve(streamResult.finishReason) as Promise<
    string | undefined
  >;
  void textPromise.catch(() => undefined);
  void finishReasonPromise.catch(() => undefined);

  const usagePromise = Promise.resolve(streamResult.usage).then(async (usage) => {
    const fullText = await textPromise;
    const normalized =
      normalizeTokenUsage(usage) ?? estimateUsage(args.promptForEstimate, fullText);
    emitModelUsed(args.runtime, args.modelType, args.model, normalized);
    return normalized as unknown as TokenUsage | undefined;
  });
  void usagePromise.catch(() => undefined);

  async function* textStreamWithUsage(): AsyncIterable<string> {
    let completed = false;
    try {
      for await (const chunk of streamResult.textStream) {
        yield chunk;
      }
      completed = true;
    } catch (streamErr) {
      logOllamaTextFailure(
        "streamText.textStream",
        String(args.modelType),
        args.model,
        args.endpoint,
        streamErr
      );
      throw streamErr;
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

/** Serialized tool `arguments` for v5 `parseMessageHandlerOutput` (expects JSON text). */
function stringifyPlannerToolArgs(arguments_: ToolCall["arguments"]): string {
  if (typeof arguments_ === "string") {
    return arguments_;
  }
  return JSON.stringify(arguments_);
}

type OllamaStreamTextWithToolsResult = TextStreamResult & {
  /** Mapped tool calls after the stream completes (parity with OpenAI `streamText` + tools). */
  toolCalls?: Promise<ToolCall[]>;
};

/**
 * `streamText` when the request includes native tools and `stream: true`.
 *
 * **Why a separate builder from `buildOllamaStreamTextResult`:** Ollama’s chat model supports
 * tools on the streaming wire; `generateText` would buffer the full completion and skip token
 * streaming entirely.
 *
 * **Planner types (`RESPONSE_HANDLER`, `ACTION_PLANNER`):** `useModel`’s streaming path sets
 * `result` to the concatenation of **`textStream` chunks only** — it never awaits our **`text`**
 * promise. Core then calls **`parseMessageHandlerOutput(fullText)`**, which expects a single JSON
 * blob of the plan. We therefore **drain** the SDK `textStream` without yielding those deltas (so
 * they are not prepended to the plan JSON) and **yield one chunk**: the first mapped tool’s
 * **`arguments`** as JSON text. **Why:** interleaving arbitrary model text with plan JSON breaks
 * `JSON.parse` on the accumulated string.
 *
 * **Other text model types:** Forward every SDK text chunk; `text` resolves to the final model
 * text. **`toolCalls`** is still attached for callers that read it from the result object.
 */
function buildOllamaStreamWithToolsResult(args: {
  runtime: IAgentRuntime;
  modelType: TextModelType;
  model: string;
  /** Resolved `OLLAMA_API_ENDPOINT` — logged when streaming fails (core consumes `textStream` after the handler returns). */
  endpoint: string;
  streamParams: StreamTextParams;
  promptForEstimate: string;
}): OllamaStreamTextWithToolsResult {
  const streamResult = streamText(args.streamParams);
  const sdkTextPromise = Promise.resolve(streamResult.text);
  const finishReasonPromise = Promise.resolve(streamResult.finishReason) as Promise<
    string | undefined
  >;
  void sdkTextPromise.catch(() => undefined);
  void finishReasonPromise.catch(() => undefined);

  const toolCallsPromise = Promise.resolve(streamResult.toolCalls).then((calls) =>
    mapAiSdkToolCallsToCore(calls as unknown[] | undefined)
  );
  void toolCallsPromise.catch(() => undefined);

  const usagePromise = Promise.resolve(streamResult.usage).then(async (usage) => {
    const fullText = await sdkTextPromise;
    const normalized =
      normalizeTokenUsage(usage) ?? estimateUsage(args.promptForEstimate, fullText);
    emitModelUsed(args.runtime, args.modelType, args.model, normalized);
    return normalized as unknown as TokenUsage | undefined;
  });
  void usagePromise.catch(() => undefined);

  const isNativePlannerType =
    args.modelType === RESPONSE_HANDLER_MODEL_TYPE ||
    args.modelType === ACTION_PLANNER_MODEL_TYPE;

  const textPromise: Promise<string> = isNativePlannerType
    ? toolCallsPromise.then(async (mapped) => {
        const first = mapped[0];
        if (first) {
          return stringifyPlannerToolArgs(first.arguments);
        }
        return sdkTextPromise.then((t) => t);
      })
    : sdkTextPromise.then((t) => t);
  void textPromise.catch(() => undefined);

  async function* textStreamWithUsage(): AsyncIterable<string> {
    let completed = false;
    try {
      if (isNativePlannerType) {
        for await (const _ of streamResult.textStream) {
          // Drain text deltas; only the trailing plan JSON chunk is yielded (see module comment).
        }
        const mapped = await toolCallsPromise;
        const first = mapped[0];
        if (first) {
          yield stringifyPlannerToolArgs(first.arguments);
        }
      } else {
        for await (const chunk of streamResult.textStream) {
          yield chunk;
        }
      }
      completed = true;
    } catch (streamErr) {
      logOllamaTextFailure(
        "streamText.textStream",
        String(args.modelType),
        args.model,
        args.endpoint,
        streamErr
      );
      throw streamErr;
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
    toolCalls: toolCallsPromise,
  };
}

type TextModelType =
  | typeof TEXT_NANO_MODEL_TYPE
  | typeof ModelType.TEXT_SMALL
  | typeof TEXT_MEDIUM_MODEL_TYPE
  | typeof ModelType.TEXT_LARGE
  | typeof TEXT_MEGA_MODEL_TYPE
  | typeof RESPONSE_HANDLER_MODEL_TYPE
  | typeof ACTION_PLANNER_MODEL_TYPE;

function getModelNameForType(runtime: IAgentRuntime, modelType: TextModelType): string {
  switch (modelType) {
    case TEXT_NANO_MODEL_TYPE:
      return getNanoModel(runtime);
    case TEXT_MEDIUM_MODEL_TYPE:
      return getMediumModel(runtime);
    case ModelType.TEXT_SMALL:
      return getSmallModel(runtime);
    case ModelType.TEXT_LARGE:
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
 * Shared path for all text model types.
 *
 * **Structured output:** `OLLAMA_DISABLE_STRUCTURED_OUTPUT` strips `responseSchema` so plain
 * text runs—**why:** operators can recover broken local models without redeploying code;
 * callers that require JSON may then fail validation (intentional trade-off).
 *
 * **Streaming vs `stream` flag:** Plain chat (`stream` true, no tools / `toolChoice` / schema)
 *   returns **`TextStreamResult`** from **`streamText`**. **`stream` + tools** uses
 *   **`buildOllamaStreamWithToolsResult`**. **`stream` + `responseSchema`** without tools still
 *   uses **`generateText`** — log at **debug**. **`stream` + `toolChoice`** without a resolved
 *   tool set uses **`generateText`** — log at **debug**; **why:** `streamText` requires tools on
 *   the wire; this path is unexpected from core.
 *
 * **Tools vs schema:** If both are present, tools win and structured output is omitted for
 * that request—**why:** v5 Stage 1 requires tools; combining `Output.object` with tools in one
 * `generateText` is not a portable contract across Ollama models.
 */
async function handleTextWithModelType(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const extended = params as GenerateTextParamsWithNativeOptions;
  const structuredDisabled = isOllamaStructuredOutputDisabled(runtime);
  let responseSchema: unknown = extended.responseSchema;
  if (structuredDisabled && extended.responseSchema) {
    logger.debug(
      "[Ollama] OLLAMA_DISABLE_STRUCTURED_OUTPUT is set — ignoring responseSchema for this call."
    );
    responseSchema = undefined;
  }

  const tools = normalizeNativeTools(extended.tools);

  const {
    prompt,
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  } = params;

  let modelIdForLog = "";
  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    const model = getModelNameForType(runtime, modelType);
    modelIdForLog = model;
    logger.log(`[Ollama] Using ${modelType} model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    const system = resolveEffectiveSystemPrompt({
      params,
      fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
    });

    let outputSpec: NativeTextOutput | undefined =
      responseSchema !== undefined && responseSchema !== null
        ? buildStructuredOutput(responseSchema)
        : undefined;

    if (tools && outputSpec) {
      // Stage-1-style calls need native tools; do not send `output` in the same request.
      logger.debug(
        "[Ollama] tools and responseSchema both present — omitting structured output for this call."
      );
      outputSpec = undefined;
    }

    const wireRaw = dropDuplicateLeadingSystemMessage(
      extended.messages as Parameters<typeof dropDuplicateLeadingSystemMessage>[0],
      system
    );
    const normalizedMessages = normalizeNativeMessages(wireRaw);
    const hasChatMessages =
      Array.isArray(normalizedMessages) && normalizedMessages.length > 0;
    const toolChoice = tools ? normalizeToolChoice(extended.toolChoice) : undefined;

    // After `outputSpec` is final (including tools-vs-schema): native return shape when the
    // call used chat messages, tools, toolChoice, or structured output — matches OpenRouter.
    const shouldReturnNative = Boolean(
      hasChatMessages ||
        tools ||
        extended.toolChoice ||
        outputSpec !== undefined
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

    const baseGenerateArgs = {
      model: ollama(model) as LanguageModel,
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

    // Streaming branches (order matters):
    // 1) tools + stream → streamText+tools (Ollama v2 supports tools on streaming /api/chat).
    // 2) stream, no tools, no toolChoice → plain streamText → TextStreamResult for SSE.
    // 3) stream + schema only → generateText below + debug (structured format not on streamText).
    // 4) stream + toolChoice but no ToolSet → generateText below + debug (invalid streamText shape).
    if (params.stream) {
      if (tools) {
        return buildOllamaStreamWithToolsResult({
          runtime,
          modelType,
          model,
          endpoint: baseURL,
          streamParams: baseGenerateArgs as StreamTextParams,
          promptForEstimate: promptForUsageEstimate,
        });
      }
      if (!extended.toolChoice) {
        if (!outputSpec) {
          return buildOllamaStreamTextResult({
            runtime,
            modelType,
            model,
            endpoint: baseURL,
            streamParams: baseGenerateArgs as StreamTextParams,
            promptForEstimate: promptForUsageEstimate,
          });
        }
        logger.debug(
          { src: "plugin:ollama:text", modelType },
          "[Ollama] stream=true with responseSchema (no tools) — using generateText. Why: ollama-ai-provider-v2 does not support structured JSON output on the streamText path for this adapter."
        );
      } else {
        logger.debug(
          { src: "plugin:ollama:text", modelType },
          "[Ollama] stream=true with toolChoice but no tools on wire — using generateText. Why: streamText+tools requires a ToolSet; callers should pass tools alongside toolChoice."
        );
      }
    }

    const result = await generateText(baseGenerateArgs);

    const usage =
      normalizeTokenUsage(result.usage) ?? estimateUsage(promptForUsageEstimate, result.text);

    emitModelUsed(runtime, modelType, model, usage);

    if (shouldReturnNative) {
      if (outputSpec !== undefined) {
        return serializeStructuredGenerateTextResult(result);
      }
      return buildNativeResultCast(result, model, usage as unknown as TokenUsage);
    }

    return result.text;
  } catch (error) {
    let endpoint = "";
    try {
      endpoint = getBaseURL(runtime);
    } catch {
      /* ignore */
    }
    logOllamaTextFailure("generateText", String(modelType), modelIdForLog || "(unknown)", endpoint, error);
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
