/**
 * Every text `ModelType` handler (nano, small, medium, large, mega, response
 * handler, action planner) routed through a single `generateTextWithModel`
 * against the `@openrouter/ai-sdk-provider` chat model. Resolves the configured
 * model name per type, builds AI SDK `generateText`/`streamText` params, and
 * emits a `MODEL_USED` usage event after each call.
 *
 * Load-bearing normalization lives here: `readToolSet` rekeys runtime
 * ToolDefinition arrays into a provider-safe `ToolSet` (bare arrays give Google
 * function names like "0"); `supportsSamplingParameters` suppresses
 * temperature/frequency/presence for `openai/*`, `anthropic/*`, and reasoning
 * models that reject them; `buildStructuredOutput` wraps a `responseSchema` into
 * the SDK `output` field; and prompt/messages/attachments are reconciled into a
 * single wire shape. Callers that pass messages/tools/toolChoice/responseSchema
 * get the richer native result object; plain prompts get a string.
 *
 * When routing Anthropic models through OpenRouter, message-level cache_control
 * is injected on the system message to enable proper Anthropic prompt caching.
 * The @openrouter/ai-sdk-provider only emits wire-level cache_control directives
 * when providerOptions.anthropic.cacheControl is attached at the message level.
 *
 * For prompt-only calls that also supply promptSegments (e.g. the PromptBatcher /
 * dynamicPromptExecFromState path), per-segment cache_control is additionally
 * injected on the user content blocks corresponding to the cacheBreakpoints from
 * the provider cache plan. This extends the single system-message breakpoint to
 * up to three more user-content breakpoints under Anthropic's four-block cap.
 */
import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
  ModelType,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";

import { createOpenRouterProvider } from "../providers";
import {
  getActionPlannerModel,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

const RESPONSES_ROUTED_PREFIXES = ["openai/", "anthropic/"] as const;
const NO_SAMPLING_MODEL_PATTERNS = ["o1", "o3", "o4", "gpt-5", "gpt-5-mini"] as const;
const TEXT_NANO_MODEL_TYPE = ModelType.TEXT_NANO as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = ModelType.TEXT_MEDIUM as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = ModelType.TEXT_MEGA as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = ModelType.RESPONSE_HANDLER as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = ModelType.ACTION_PLANNER as ModelTypeName;

type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

interface OpenRouterPromptCacheOptions {
  promptCacheKey?: string;
}

interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

type GenerateTextParamsWithAttachments = GenerateTextParams & {
  attachments?: ChatAttachment[];
  messages?: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  responseSchema?: unknown;
  providerOptions?: Record<string, object | unknown> & {
    openrouter?: OpenRouterPromptCacheOptions;
    anthropic?: {
      cacheControl?: AnthropicCacheControl;
      cacheSystem?: boolean;
      cacheBreakpoints?: unknown[];
      maxBreakpoints?: number;
    };
  };
};

type NativeOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;
type NativeGenerateTextParams = Parameters<typeof generateText<ToolSet, NativeOutput>>[0];
type NativeStreamTextParams = Parameters<typeof streamText<ToolSet, NativeOutput>>[0];
type NativePrompt =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };
type NativeTextParams = Omit<NativeGenerateTextParams, "messages" | "prompt"> &
  Omit<NativeStreamTextParams, "messages" | "prompt"> &
  NativePrompt;

type NormalizedUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type NativeGenerateTextResult = {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: NormalizedUsage;
};
type NativeTextModelResult = string & NativeGenerateTextResult;

function buildUserContent(
  params: GenerateTextParamsWithAttachments,
  options: { includePrompt?: boolean } = { includePrompt: true }
): UserContent {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "file";
        data: string | Uint8Array | URL;
        mediaType: string;
        filename?: string;
      }
  > = [];

  if (
    options.includePrompt !== false &&
    typeof params.prompt === "string" &&
    params.prompt.length > 0
  ) {
    content.push({ type: "text", text: params.prompt });
  }

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

function appendUserContentToMessages(
  messages: ModelMessage[],
  extraContent: UserContent
): ModelMessage[] {
  if (extraContent.length === 0) {
    return messages;
  }

  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex === -1) {
    return [...messages, { role: "user" as const, content: extraContent }];
  }

  const nextMessages = [...messages];
  const userMessage = nextMessages[lastUserIndex];
  if (!userMessage) {
    return messages;
  }
  const existingContent = userMessage.content;
  const content = [
    ...(typeof existingContent === "string"
      ? [{ type: "text" as const, text: existingContent }]
      : Array.isArray(existingContent)
        ? existingContent
        : []),
    ...extraContent,
  ];

  nextMessages[lastUserIndex] = {
    ...userMessage,
    content,
  } as ModelMessage;

  return nextMessages;
}

function textFromMessages(messages: ModelMessage[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  return messages
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : ""
        )
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function supportsSamplingParameters(modelName: string): boolean {
  const lowerModelName = modelName.toLowerCase();

  if (RESPONSES_ROUTED_PREFIXES.some((prefix) => lowerModelName.startsWith(prefix))) {
    return false;
  }

  return !NO_SAMPLING_MODEL_PATTERNS.some((pattern) => lowerModelName.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAnthropicModel(modelName: string): boolean {
  return modelName.toLowerCase().startsWith("anthropic/");
}

function buildCacheableSystemMessage(
  systemPrompt: string | undefined,
  cacheControl: AnthropicCacheControl | undefined
): ModelMessage | undefined {
  if (!systemPrompt) {
    return undefined;
  }
  if (!cacheControl) {
    return undefined;
  }
  return {
    role: "system",
    content: systemPrompt,
    providerOptions: {
      anthropic: { cacheControl },
    },
  } as unknown as ModelMessage;
}

function readAnthropicCacheControl(
  anthropicOptions: Record<string, unknown> | undefined
): AnthropicCacheControl | undefined {
  if (!anthropicOptions) {
    return undefined;
  }
  const cacheControl = anthropicOptions.cacheControl;
  if (isRecord(cacheControl) && cacheControl.type === "ephemeral") {
    return {
      type: "ephemeral",
      ...(cacheControl.ttl === "5m" || cacheControl.ttl === "1h" ? { ttl: cacheControl.ttl } : {}),
    };
  }
  return anthropicOptions.cacheSystem === true ? { type: "ephemeral" } : undefined;
}

function stripLocalAnthropicCacheOptions(
  anthropicOptions: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!anthropicOptions) {
    return undefined;
  }
  // Strip elizaOS-internal fields that are not Anthropic wire parameters.
  // cacheBreakpoints and maxBreakpoints are consumed here to build segmented
  // user content; sending them through would produce unknown-field errors.
  const {
    cacheControl: _cacheControl,
    cacheSystem: _cacheSystem,
    cacheBreakpoints: _cacheBreakpoints,
    maxBreakpoints: _maxBreakpoints,
    ...wireOptions
  } = anthropicOptions;
  return Object.keys(wireOptions).length > 0 ? wireOptions : undefined;
}

function getRuntimeCacheControl(runtime: IAgentRuntime): AnthropicCacheControl {
  const ttl = runtime.getSetting("ANTHROPIC_PROMPT_CACHE_TTL");
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

type AnthropicCacheBreakpoint = { segmentIndex: number; cacheControl: AnthropicCacheControl };

// Extends the AI SDK TextPart shape with provider-metadata so the AI SDK can forward
// cache_control directives to the wire without losing the type guarantee on type/text.
type CacheableTextPart = {
  type: "text";
  text: string;
  providerOptions?: Record<string, unknown>;
};

function isAnthropicCacheBreakpoint(value: unknown): value is AnthropicCacheBreakpoint {
  return (
    isRecord(value) &&
    typeof value.segmentIndex === "number" &&
    Number.isInteger(value.segmentIndex) &&
    value.segmentIndex >= 0 &&
    isRecord(value.cacheControl) &&
    value.cacheControl.type === "ephemeral"
  );
}

function readAnthropicCacheBreakpoints(
  anthropicOptions: Record<string, unknown> | undefined,
  maxBreakpoints: number
): AnthropicCacheBreakpoint[] {
  const raw = anthropicOptions?.cacheBreakpoints;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAnthropicCacheBreakpoint).slice(0, maxBreakpoints);
}

/**
 * Builds user content as multiple text blocks (one per prompt segment) so that
 * Anthropic cache_control breakpoints can be applied at the segment level, up to
 * the three user-content slots under Anthropic's four-block cache cap. Only used
 * on the prompt-only path (no `messages` supplied) when promptSegments and
 * cacheBreakpoints are both available.
 */
function buildSegmentedPromptUserContent(
  promptSegments: Array<{ content: string; stable?: boolean }>,
  cacheBreakpoints: AnthropicCacheBreakpoint[]
): CacheableTextPart[] {
  if (cacheBreakpoints.length === 0) {
    return promptSegments.map((seg) => ({ type: "text" as const, text: seg.content }));
  }
  const breakpointMap = new Map<number, AnthropicCacheControl>(
    cacheBreakpoints.map((bp) => [bp.segmentIndex, bp.cacheControl])
  );
  return promptSegments.map((seg, index) => {
    const cc = breakpointMap.get(index);
    if (cc) {
      return {
        type: "text" as const,
        text: seg.content,
        providerOptions: { anthropic: { cacheControl: cc } },
      };
    }
    return { type: "text" as const, text: seg.content };
  });
}

function readToolSet(value: GenerateTextParams["tools"]): ToolSet | undefined {
  if (!value) {
    return undefined;
  }

  // The runtime exposes tools as ordered ToolDefinition arrays. The AI SDK
  // expects a ToolSet keyed by provider-visible tool names; passing the array
  // through gives providers function names like "0", which Google rejects.
  const isArr = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const namedKeys = new Set<string>();
  for (const [, rawTool] of entries) {
    if (isRecord(rawTool) && typeof rawTool.name === "string" && rawTool.name) {
      namedKeys.add(rawTool.name);
    }
  }

  const tools: Record<string, unknown> = {};
  let sawNamedTool = false;
  for (const [origKey, rawTool] of entries) {
    if (!isRecord(rawTool)) {
      continue;
    }
    const functionTool = isRecord(rawTool.function) ? rawTool.function : undefined;
    const name =
      typeof rawTool.name === "string" && rawTool.name
        ? rawTool.name
        : typeof functionTool?.name === "string" && functionTool.name
          ? functionTool.name
          : undefined;
    if (name) {
      sawNamedTool = true;
      const schema = isRecord(rawTool.parameters)
        ? (rawTool.parameters as JSONSchema7)
        : isRecord(functionTool?.parameters)
          ? (functionTool.parameters as JSONSchema7)
          : isRecord(rawTool.input_schema)
            ? (rawTool.input_schema as JSONSchema7)
            : ({ type: "object" } satisfies JSONSchema7);
      const description =
        typeof rawTool.description === "string"
          ? rawTool.description
          : typeof functionTool?.description === "string"
            ? functionTool.description
            : undefined;
      tools[name] = {
        ...(description ? { description } : {}),
        inputSchema: jsonSchema(schema),
      };
    } else if (!isArr && !namedKeys.has(origKey)) {
      tools[origKey] = rawTool;
    }
  }

  if (sawNamedTool) {
    return Object.keys(tools).length > 0 ? (tools as ToolSet) : undefined;
  }
  return !isArr && isRecord(value) ? (value as ToolSet) : undefined;
}

function readToolChoice(value: GenerateTextParams["toolChoice"]): ToolChoice<ToolSet> | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string" && (value === "auto" || value === "none" || value === "required")) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const choice = value as Record<string, unknown>;
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "tool", toolName: choice.name };
  }
  if (choice.type === "function" && isRecord(choice.function)) {
    const name = choice.function.name;
    return typeof name === "string" ? { type: "tool", toolName: name } : undefined;
  }
  return typeof choice.name === "string" ? { type: "tool", toolName: choice.name } : undefined;
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

  return {
    name: "object",
    responseFormat: Promise.resolve({
      type: "json" as const,
      schema: schemaOptions.schema as JSONSchema7,
      ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
      ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
    }),
    async parseCompleteOutput({ text }: { text: string }) {
      return JSON.parse(text);
    },
    async parsePartialOutput(): Promise<undefined> {
      return undefined;
    },
    createElementStreamTransform(): undefined {
      return undefined;
    },
  } satisfies NativeOutput;
}

function usesNativeTextResult(params: GenerateTextParamsWithAttachments): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
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

function getModelLabelForType(modelType: TextModelType): string {
  switch (modelType) {
    case TEXT_NANO_MODEL_TYPE:
      return "TEXT_NANO";
    case TEXT_MEDIUM_MODEL_TYPE:
      return "TEXT_MEDIUM";
    case ModelType.TEXT_SMALL:
      return "TEXT_SMALL";
    case ModelType.TEXT_LARGE:
      return "TEXT_LARGE";
    case TEXT_MEGA_MODEL_TYPE:
      return "TEXT_MEGA";
    case RESPONSE_HANDLER_MODEL_TYPE:
      return "RESPONSE_HANDLER";
    case ACTION_PLANNER_MODEL_TYPE:
      return "ACTION_PLANNER";
    default:
      return String(modelType);
  }
}

function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
) {
  const paramsWithAttachments = params as GenerateTextParamsWithAttachments;
  const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
  const usagePrompt = prompt ?? textFromMessages(paramsWithAttachments.messages);
  const paramsWithMax = params as GenerateTextParams & {
    maxOutputTokens?: number;
    maxTokens?: number;
  };
  // Opt-out (direct-channel Stage-1): send no cap so the model's own max applies
  // — a hardcoded value 400s when it exceeds the model's limit. Otherwise resolve
  // the explicit value or the 8192 default.
  const resolvedMaxOutput = params.omitMaxTokens
    ? undefined
    : (paramsWithMax.maxOutputTokens ?? paramsWithMax.maxTokens ?? 8192);

  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getModelNameForType(runtime, modelType);
  const modelLabel = getModelLabelForType(modelType);
  const supportsSampling = supportsSamplingParameters(modelName);
  const stopSequences =
    Array.isArray(params.stopSequences) && params.stopSequences.length > 0
      ? params.stopSequences
      : undefined;
  const userContent =
    (paramsWithAttachments.attachments?.length ?? 0) > 0
      ? buildUserContent(paramsWithAttachments)
      : undefined;
  const attachmentContent =
    paramsWithAttachments.messages && (paramsWithAttachments.attachments?.length ?? 0) > 0
      ? buildUserContent(paramsWithAttachments, { includePrompt: false })
      : undefined;
  const temperature = params.temperature ?? 0.7;
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;
  const systemPrompt = resolveEffectiveSystemPrompt({
    params: paramsWithAttachments,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });

  const wireMessages = dropDuplicateLeadingSystemMessage(
    paramsWithAttachments.messages,
    systemPrompt
  );

  // Detect if we need to inject Anthropic message-level cache control.
  // When the caller passes an explicit providerOptions.anthropic.cacheControl we
  // use that; otherwise we fall back to reading ANTHROPIC_PROMPT_CACHE_TTL from
  // runtime settings — matching the always-on behaviour of plugin-anthropic so
  // that every Anthropic model routed through OpenRouter gets at least the
  // system-message breakpoint regardless of whether the calling path assembled a
  // full cache plan (e.g. the PromptBatcher / dynamicPromptExecFromState path).
  const isAnthropic = isAnthropicModel(modelName);
  const rawProviderOptions = paramsWithAttachments.providerOptions;
  const anthropicOptions = isRecord(rawProviderOptions?.anthropic)
    ? rawProviderOptions.anthropic
    : undefined;
  const anthropicCacheControl =
    readAnthropicCacheControl(anthropicOptions) ??
    (isAnthropic ? getRuntimeCacheControl(runtime) : undefined);
  const anthropicCacheSystem = anthropicOptions?.cacheSystem !== false;
  const cacheSystemMessage =
    isAnthropic && anthropicCacheSystem
      ? buildCacheableSystemMessage(systemPrompt, anthropicCacheControl)
      : undefined;
  const shouldInjectMessageLevelCache = Boolean(cacheSystemMessage);

  // Collect cacheBreakpoints for per-segment user-content injection.
  // Only used on the prompt-only path (no messages) together with promptSegments.
  // maxBreakpoints caps the number of slots used (Anthropic allows up to 3 user-content).
  const maxBreakpoints =
    typeof anthropicOptions?.maxBreakpoints === "number" &&
    Number.isInteger(anthropicOptions.maxBreakpoints) &&
    anthropicOptions.maxBreakpoints >= 0
      ? anthropicOptions.maxBreakpoints
      : 3;
  const cacheBreakpoints = readAnthropicCacheBreakpoints(anthropicOptions, maxBreakpoints);
  const promptSegments = Array.isArray(
    (paramsWithAttachments as { promptSegments?: unknown }).promptSegments
  )
    ? ((paramsWithAttachments as { promptSegments?: Array<{ content: string; stable?: boolean }> })
        .promptSegments ?? [])
    : [];

  let finalWireMessages = wireMessages;
  if (cacheSystemMessage && paramsWithAttachments.messages) {
    finalWireMessages = [cacheSystemMessage, ...(wireMessages || [])];
  }

  const promptOrMessages: NativePrompt = paramsWithAttachments.messages
    ? finalWireMessages && finalWireMessages.length > 0
      ? {
          messages: attachmentContent
            ? appendUserContentToMessages(finalWireMessages, attachmentContent)
            : finalWireMessages,
        }
      : userContent
        ? { messages: [{ role: "user" as const, content: userContent }] }
        : prompt !== undefined
          ? { prompt }
          : (() => {
              throw new Error(
                "OpenRouter text generation requires prompt, messages, or attachments"
              );
            })()
    : shouldInjectMessageLevelCache && cacheSystemMessage
      ? userContent || prompt !== undefined
        ? {
            messages: [
              cacheSystemMessage,
              {
                role: "user" as const,
                // When promptSegments and cacheBreakpoints are both available,
                // build multi-block user content so per-segment cache_control can
                // be stamped on the last block of each stable run (up to three
                // additional breakpoints under Anthropic's four-block cap).
                content:
                  promptSegments.length > 0 && cacheBreakpoints.length > 0 && !userContent
                    ? (buildSegmentedPromptUserContent(
                        promptSegments,
                        cacheBreakpoints
                      ) as UserContent)
                    : (userContent ?? buildUserContent(paramsWithAttachments)),
              },
            ],
          }
        : (() => {
            throw new Error("OpenRouter text generation requires prompt, messages, or attachments");
          })()
      : userContent
        ? { messages: [{ role: "user" as const, content: userContent }] }
        : prompt !== undefined
          ? { prompt }
          : (() => {
              throw new Error(
                "OpenRouter text generation requires prompt, messages, or attachments"
              );
            })();

  // Resolve providerOptions: forward any caller-supplied options and merge in
  // the openrouter.promptCacheKey when present. OpenRouter passes prompt_cache_key
  // through to the underlying model provider for prefix caching.
  const {
    openrouter: rawOpenrouterOptions,
    anthropic: _,
    ...restProviderOptions
  } = rawProviderOptions ?? {};
  const openrouterOptions: Record<string, unknown> = {
    ...(rawOpenrouterOptions ?? {}),
  };

  // Strip local Anthropic cache options if we injected message-level cache
  const wireAnthropicOptions = shouldInjectMessageLevelCache
    ? stripLocalAnthropicCacheOptions(anthropicOptions)
    : anthropicOptions;

  const mergedProviderOptions: Record<string, unknown> = {
    ...restProviderOptions,
    ...(Object.keys(openrouterOptions).length > 0 ? { openrouter: openrouterOptions } : {}),
    ...(wireAnthropicOptions ? { anthropic: wireAnthropicOptions } : {}),
  };
  const resolvedProviderOptions =
    Object.keys(mergedProviderOptions).length > 0 ? mergedProviderOptions : undefined;
  const normalizedTools = readToolSet(paramsWithAttachments.tools);
  const normalizedToolChoice = readToolChoice(paramsWithAttachments.toolChoice);

  type NativeProviderOptions = NativeTextParams["providerOptions"];
  const generateParams: NativeTextParams = {
    model: openrouter.chat(modelName) as LanguageModel,
    ...promptOrMessages,
    // Omit system parameter when we injected message-level cache to prevent duplication
    ...(shouldInjectMessageLevelCache ? {} : { system: systemPrompt }),
    ...(supportsSampling
      ? {
          temperature: temperature,
          frequencyPenalty: frequencyPenalty,
          presencePenalty: presencePenalty,
          ...(stopSequences ? { stopSequences } : {}),
        }
      : {}),
    ...(resolvedMaxOutput !== undefined ? { maxOutputTokens: resolvedMaxOutput } : {}),
    ...(normalizedTools ? { tools: normalizedTools } : {}),
    ...(normalizedToolChoice ? { toolChoice: normalizedToolChoice } : {}),
    ...(paramsWithAttachments.responseSchema
      ? { output: buildStructuredOutput(paramsWithAttachments.responseSchema) }
      : {}),
    ...(resolvedProviderOptions
      ? { providerOptions: resolvedProviderOptions as NativeProviderOptions }
      : {}),
  };

  return {
    generateParams,
    modelName,
    modelLabel,
    prompt: usagePrompt,
    shouldReturnNativeResult: usesNativeTextResult(paramsWithAttachments),
  };
}

type GenerateParams = ReturnType<typeof buildGenerateParams>["generateParams"];

function handleStreamingGeneration(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  generateParams: GenerateParams,
  prompt: string,
  modelName: string,
  modelLabel: string,
  shouldReturnNativeResult: boolean
): TextStreamResult {
  let capturedStreamError: unknown;
  const streamResult = streamText({
    ...(generateParams as Parameters<typeof streamText>[0]),
    onError: ({ error }: { error: unknown }) => {
      capturedStreamError = error;
    },
  });
  const usagePromise = Promise.resolve(streamResult.usage).then((usage) => {
    if (!usage) {
      return undefined;
    }

    return emitModelUsageEvent(runtime, modelType, prompt, usage, modelName, modelLabel);
  });
  // error-policy:J5 unhandled-rejection suppression — usage emission is
  // telemetry; the underlying stream failure is observed in
  // `textStreamWithUsage` below (capturedStreamError rethrow), never here.
  const ignoreUsageError = (): undefined => undefined;

  async function* textStreamWithUsage(): AsyncIterable<string> {
    let completed = false;
    try {
      for await (const chunk of streamResult.textStream) {
        yield chunk;
      }
      completed = true;
      // error-policy:J2 context-adding rethrow — a rejected finishReason is
      // captured and rethrown as the typed stream error just below; it is never
      // swallowed into a healthy-empty stream.
      await Promise.resolve(streamResult.finishReason).catch((error) => {
        capturedStreamError ??= error;
      });
      if (capturedStreamError) {
        throw capturedStreamError instanceof Error
          ? capturedStreamError
          : new Error(`[OpenRouter] streaming provider error: ${String(capturedStreamError)}`);
      }
    } finally {
      if (completed) {
        await usagePromise.catch(ignoreUsageError);
      }
    }
  }

  return {
    textStream: textStreamWithUsage(),
    text: Promise.resolve(streamResult.text).then(async (text) => {
      await usagePromise.catch(ignoreUsageError);
      return text;
    }),
    ...(shouldReturnNativeResult ? { toolCalls: Promise.resolve(streamResult.toolCalls) } : {}),
    usage: usagePromise,
    finishReason: Promise.resolve(streamResult.finishReason) as Promise<string | undefined>,
  };
}

function buildNativeTextResult(result: {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}): NativeGenerateTextResult {
  const inputTokens = result.usage?.inputTokens ?? result.usage?.promptTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? result.usage?.completionTokens ?? 0;

  if (!result.usage) {
    return {
      text: result.text,
      toolCalls: result.toolCalls ?? [],
      finishReason: result.finishReason,
    };
  }

  const cacheRead = result.usage.cacheReadInputTokens ?? result.usage.cachedInputTokens;
  const cacheCreation = result.usage.cacheCreationInputTokens;

  const usage: NormalizedUsage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
    ...(typeof cacheRead === "number" ? { cacheReadInputTokens: cacheRead } : {}),
    ...(typeof cacheCreation === "number" ? { cacheCreationInputTokens: cacheCreation } : {}),
  };

  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    usage,
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const { generateParams, modelName, modelLabel, prompt, shouldReturnNativeResult } =
    buildGenerateParams(runtime, modelType, params);

  if (params.stream) {
    return handleStreamingGeneration(
      runtime,
      modelType,
      generateParams,
      prompt,
      modelName,
      modelLabel,
      shouldReturnNativeResult
    );
  }

  const response = await generateText(generateParams);

  if (response.usage) {
    emitModelUsageEvent(runtime, modelType, prompt, response.usage, modelName, modelLabel);
  }

  if (shouldReturnNativeResult) {
    return buildNativeTextResult(response) as NativeTextModelResult;
  }

  return response.text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_SMALL, params);
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
  return generateTextWithModel(runtime, ModelType.TEXT_LARGE, params);
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
