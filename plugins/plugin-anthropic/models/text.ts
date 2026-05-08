import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  PromptSegment,
  TextStreamResult,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
  logger,
  ModelType,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import {
  generateText,
  type JSONSchema7,
  type ModelMessage,
  streamText,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";
import { createAnthropicClientWithTopPSupport } from "../providers";
import type { ModelName, ModelSize, ProviderOptions } from "../types";
import { generateViaCli, streamViaCli } from "../utils/claude-cli";
import {
  getActionPlannerModel,
  getAuthMode,
  getCoTBudget,
  getExperimentalTelemetry,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getReasoningLargeModel,
  getReasoningSmallModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { executeWithRetry, formatModelError } from "../utils/retry";

type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

interface ResolvedTextParams {
  readonly prompt: string;
  readonly stopSequences: readonly string[];
  readonly maxTokens: number;
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly frequencyPenalty: number;
  readonly presencePenalty: number;
  readonly providerOptions: ProviderOptions;
}

interface GenerateTextParamsWithProviderOptions
  extends Omit<GenerateTextParams, "messages" | "tools" | "toolChoice" | "responseSchema"> {
  attachments?: ChatAttachment[];
  messages?: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  responseSchema?: unknown;
  providerOptions?: ProviderOptions;
}

type NativeOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;
type NativeGenerateTextParams = Parameters<typeof generateText<ToolSet, NativeOutput>>[0];
type NativeStreamTextParams = Parameters<typeof streamText<ToolSet, NativeOutput>>[0];
type NativePrompt =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };
type NativeTextParams = Omit<NativeGenerateTextParams, "messages" | "prompt"> &
  Omit<NativeStreamTextParams, "messages" | "prompt"> &
  NativePrompt;
type NativeProviderOptions = NativeTextParams["providerOptions"];
type NativeTelemetrySettings = NativeTextParams["experimental_telemetry"];

type AnthropicCacheControl = NonNullable<NonNullable<ProviderOptions["anthropic"]>["cacheControl"]>;
type AnthropicCacheBreakpoint = {
  segmentIndex?: number;
  ttl?: "short" | "long" | "5m" | "1h";
  cacheControl?: AnthropicCacheControl;
};

interface AnthropicUsageWithCache {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface AnthropicNormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface NativeGenerateTextResult {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: AnthropicNormalizedUsage;
}

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
  | typeof ACTION_PLANNER_MODEL_TYPE
  | typeof TEXT_REASONING_SMALL_MODEL_TYPE
  | typeof TEXT_REASONING_LARGE_MODEL_TYPE;
type AnthropicTextPart = {
  type: "text";
  text: string;
  providerOptions?: {
    anthropic?: {
      cacheControl?: AnthropicCacheControl;
    };
  };
};
type AnthropicFilePart = {
  type: "file";
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};
type AnthropicUserContentPart = AnthropicTextPart | AnthropicFilePart;

function isOpus4Model(modelName: ModelName): boolean {
  return modelName.toLowerCase().includes("opus-4");
}

function buildUserContent(params: GenerateTextParamsWithProviderOptions): UserContent {
  const content: AnthropicUserContentPart[] = [{ type: "text", text: params.prompt }];

  appendAttachments(content, params.attachments);

  return content;
}

function appendAttachments(
  content: AnthropicUserContentPart[],
  attachments: ChatAttachment[] | undefined
): void {
  for (const attachment of attachments ?? []) {
    content.push({
      type: "file",
      data: attachment.data,
      mediaType: attachment.mediaType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }
}

function buildSegmentedUserContent(
  params: GenerateTextParamsWithProviderOptions,
  anthropicOptions?: ProviderOptions["anthropic"],
  fallbackCacheControl?: AnthropicCacheControl
): UserContent {
  const segmentCacheControls = buildSegmentCacheControls(
    params,
    anthropicOptions,
    fallbackCacheControl
  );
  return buildSegmentedUserContentFromSegments(
    params.promptSegments ?? [],
    params.attachments,
    segmentCacheControls
  );
}

function buildSegmentedUserContentFromSegments(
  segments: readonly PromptSegment[],
  attachments: ChatAttachment[] | undefined,
  segmentCacheControls: Map<number, AnthropicCacheControl> = new Map()
): UserContent {
  const content: AnthropicUserContentPart[] = [];

  for (const [index, segment] of segments.entries()) {
    const textPart: AnthropicTextPart = {
      type: "text",
      text: segment.content,
    };
    const cacheControl = segmentCacheControls.get(index);
    if (cacheControl) {
      textPart.providerOptions = { anthropic: { cacheControl } };
    }
    content.push(textPart);
  }

  appendAttachments(content, attachments);

  return content;
}

function buildSegmentedUserContentForMessages(
  params: GenerateTextParamsWithProviderOptions
): UserContent | undefined {
  const dynamicSegments = (params.promptSegments ?? []).filter((segment) => !segment.stable);
  if (dynamicSegments.length === 0 && (params.attachments?.length ?? 0) === 0) {
    return undefined;
  }
  return buildSegmentedUserContentFromSegments(dynamicSegments, params.attachments);
}

function buildPlannerWireMessages(
  wireMessages: ModelMessage[],
  userContent: UserContent | string
): ModelMessage[] {
  if (wireMessages[0]?.role === "user") {
    const [first, ...tail] = wireMessages;
    return [{ ...first, content: userContent }, ...tail];
  }
  return [{ role: "user", content: userContent }, ...wireMessages];
}

function buildSegmentCacheControls(
  params: GenerateTextParamsWithProviderOptions,
  anthropicOptions?: ProviderOptions["anthropic"],
  fallbackCacheControl?: AnthropicCacheControl
): Map<number, AnthropicCacheControl> {
  const controls = new Map<number, AnthropicCacheControl>();
  if (!fallbackCacheControl) {
    return controls;
  }

  const maxBreakpointsRaw = anthropicOptions?.maxBreakpoints;
  const maxBreakpoints =
    typeof maxBreakpointsRaw === "number" && Number.isFinite(maxBreakpointsRaw)
      ? Math.max(0, Math.floor(maxBreakpointsRaw))
      : 4;
  const systemConsumesBreakpoint = anthropicOptions?.cacheSystem !== false;
  const maxSegmentBreakpoints = Math.max(0, maxBreakpoints - (systemConsumesBreakpoint ? 1 : 0));
  const plannedBreakpoints = Array.isArray(anthropicOptions?.cacheBreakpoints)
    ? (anthropicOptions.cacheBreakpoints as AnthropicCacheBreakpoint[])
    : undefined;

  if (plannedBreakpoints) {
    for (const breakpoint of plannedBreakpoints.slice(0, maxSegmentBreakpoints)) {
      if (typeof breakpoint.segmentIndex !== "number") {
        continue;
      }
      controls.set(
        breakpoint.segmentIndex,
        normalizeBreakpointCacheControl(breakpoint, fallbackCacheControl)
      );
    }
    return controls;
  }

  let selected = 0;
  for (const [index, segment] of (params.promptSegments ?? []).entries()) {
    if (!segment.stable) {
      continue;
    }
    controls.set(index, fallbackCacheControl);
    selected++;
    if (selected >= maxSegmentBreakpoints) {
      break;
    }
  }
  return controls;
}

function normalizeBreakpointCacheControl(
  breakpoint: AnthropicCacheBreakpoint,
  fallbackCacheControl: AnthropicCacheControl
): AnthropicCacheControl {
  if (isAnthropicCacheControl(breakpoint.cacheControl)) {
    return breakpoint.cacheControl;
  }
  if (breakpoint.ttl === "long" || breakpoint.ttl === "1h") {
    return { type: "ephemeral", ttl: "1h" };
  }
  if (breakpoint.ttl === "short" || breakpoint.ttl === "5m") {
    return { ...fallbackCacheControl };
  }
  return fallbackCacheControl;
}

function isAnthropicCacheControl(value: unknown): value is AnthropicCacheControl {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ephemeral"
  );
}

function getRuntimeCacheControl(runtime: IAgentRuntime): AnthropicCacheControl {
  // cache_control is always emitted for stable segments — Anthropic requires it.
  // TTL is configurable via ANTHROPIC_PROMPT_CACHE_TTL ("5m" | "1h"); default is "5m".
  const ttlSetting = runtime.getSetting("ANTHROPIC_PROMPT_CACHE_TTL");
  if (typeof ttlSetting === "string") {
    const ttl = ttlSetting.trim().toLowerCase();
    if (ttl === "1h") {
      return { type: "ephemeral", ttl: "1h" };
    }
  }
  return { type: "ephemeral" };
}

function buildCacheableSystemPrompt(
  systemPrompt: string | undefined,
  cacheControl: AnthropicCacheControl | undefined
): NativeTextParams["system"] {
  if (!systemPrompt) {
    return undefined;
  }
  if (!cacheControl) {
    return systemPrompt;
  }
  return {
    role: "system",
    content: systemPrompt,
    providerOptions: {
      anthropic: { cacheControl },
    },
  };
}

function stripLocalAnthropicCacheOptions(
  anthropicOptions: ProviderOptions["anthropic"] | undefined
): ProviderOptions["anthropic"] | undefined {
  if (!anthropicOptions) {
    return undefined;
  }
  const {
    cacheControl: _cacheControl,
    cacheBreakpoints: _cacheBreakpoints,
    cacheSystem: _cacheSystem,
    maxBreakpoints: _maxBreakpoints,
    ...wireOptions
  } = anthropicOptions as Record<string, unknown>;
  return Object.keys(wireOptions).length > 0
    ? (wireOptions as ProviderOptions["anthropic"])
    : undefined;
}

function normalizeAnthropicUsage(
  usage: AnthropicUsageWithCache | undefined
): AnthropicNormalizedUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
      : {}),
  };
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

function usesNativeTextResult(params: GenerateTextParamsWithProviderOptions): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

function buildNativeTextResult(result: {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: AnthropicUsageWithCache;
}): NativeGenerateTextResult {
  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    usage: normalizeAnthropicUsage(result.usage),
  };
}

function resolveTextParams(
  params: GenerateTextParams,
  modelName: ModelName,
  cotBudget: number
): ResolvedTextParams {
  const prompt = params.prompt;
  const stopSequences = params.stopSequences ?? [];
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;

  const hasTopP = params.topP !== undefined;
  const hasTemperature = params.temperature !== undefined;

  let temperature: number | undefined;
  let topP: number | undefined;

  if (hasTopP && hasTemperature) {
    // Anthropic only supports one at a time; prefer temperature, drop topP
    logger.warn(
      "[Anthropic] Both temperature and topP provided; using temperature only (Anthropic API limitation)."
    );
    temperature = params.temperature;
    topP = undefined;
  } else if (hasTopP) {
    topP = params.topP;
    temperature = undefined;
  } else {
    temperature = params.temperature ?? 0.7;
    topP = undefined;
  }

  // Opus 4.x only accepts temperature=1 (extended-thinking-capable models).
  // Anthropic returns 400 "Invalid request data" otherwise.
  if (isOpus4Model(modelName) && temperature !== undefined && temperature !== 1) {
    temperature = 1;
  }

  const defaultMaxTokens = modelName.includes("-3-") ? 4096 : 8192;
  // Cap output tokens at the model's hard limit. Opus 4.x = 32k, Sonnet 4.x = 64k.
  // Callers (eliza runtime) sometimes pass the prompt context window (128k+) as
  // maxTokens, which the API rejects with "Invalid request data".
  const maxTokens = Math.min(
    params.maxTokens ?? defaultMaxTokens,
    isOpus4Model(modelName) ? 32_000 : 64_000
  );

  const rawProviderOptions = (params as unknown as GenerateTextParamsWithProviderOptions)
    .providerOptions;
  const baseProviderOptions: ProviderOptions = rawProviderOptions
    ? {
        ...rawProviderOptions,
        anthropic: rawProviderOptions.anthropic ? { ...rawProviderOptions.anthropic } : undefined,
      }
    : {};

  const providerOptions: ProviderOptions =
    cotBudget > 0
      ? {
          ...baseProviderOptions,
          anthropic: {
            ...(baseProviderOptions.anthropic ?? {}),
            thinking: { type: "enabled", budgetTokens: cotBudget },
          },
        }
      : baseProviderOptions;

  return {
    prompt,
    stopSequences,
    maxTokens,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    providerOptions,
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelName: ModelName,
  modelSize: ModelSize,
  modelType: TextModelType
): Promise<string | TextStreamResult> {
  const paramsWithAttachments = params as unknown as GenerateTextParamsWithProviderOptions;
  const shouldReturnNativeResult = usesNativeTextResult(paramsWithAttachments);
  const systemPrompt = resolveEffectiveSystemPrompt({
    params: paramsWithAttachments,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });

  if (getAuthMode(runtime) === "cli") {
    if (shouldReturnNativeResult) {
      throw new Error(
        "[Anthropic] Native messages, tools, toolChoice, and responseSchema are not supported when ANTHROPIC_AUTH_MODE=cli."
      );
    }
    if (params.stream) {
      return streamViaCli(
        runtime,
        params.prompt,
        modelName,
        modelType,
        params.maxTokens,
        systemPrompt
      );
    }
    const result = await generateViaCli(
      runtime,
      params.prompt,
      modelName,
      modelType,
      params.maxTokens,
      systemPrompt
    );
    return result.text;
  }

  const anthropic = createAnthropicClientWithTopPSupport(runtime);
  const experimentalTelemetry = getExperimentalTelemetry(runtime);
  const cotBudget = getCoTBudget(runtime, modelSize);

  logger.log(`[Anthropic] Using ${modelType} model: ${modelName}`);

  const resolved = resolveTextParams(params, modelName, cotBudget);
  // cache_control is always-on: getRuntimeCacheControl always returns a value.
  // Callers can still override by supplying anthropic.cacheControl in providerOptions.
  const runtimeCacheControl = getRuntimeCacheControl(runtime);
  const providerOptions: ProviderOptions = {
    ...resolved.providerOptions,
    anthropic: {
      ...(resolved.providerOptions.anthropic ?? {}),
      ...(!resolved.providerOptions.anthropic?.cacheControl
        ? { cacheControl: runtimeCacheControl }
        : {}),
    },
  };
  const segmentedPrompt =
    Array.isArray(paramsWithAttachments.promptSegments) &&
    paramsWithAttachments.promptSegments.length > 0;
  const cacheControl = providerOptions.anthropic?.cacheControl;
  const cacheSystem = providerOptions.anthropic?.cacheSystem !== false;
  const system = buildCacheableSystemPrompt(systemPrompt, cacheSystem ? cacheControl : undefined);
  const userContent =
    segmentedPrompt || (paramsWithAttachments.attachments?.length ?? 0) > 0
      ? segmentedPrompt
        ? buildSegmentedUserContent(paramsWithAttachments, providerOptions.anthropic, cacheControl)
        : buildUserContent(paramsWithAttachments)
      : undefined;
  const anthropicOptions =
    providerOptions.anthropic && (segmentedPrompt || system)
      ? stripLocalAnthropicCacheOptions(providerOptions.anthropic)
      : providerOptions.anthropic;
  const anthropicProviderOptions = anthropicOptions ? { anthropic: anthropicOptions } : undefined;

  const agentName = resolved.providerOptions.agentName;
  const telemetryConfig: NativeTelemetrySettings = {
    isEnabled: experimentalTelemetry,
    functionId: agentName ? `agent:${agentName}` : undefined,
    metadata: agentName ? { agentName } : undefined,
  };

  const wireMessages = dropDuplicateLeadingSystemMessage(
    paramsWithAttachments.messages,
    systemPrompt
  );
  const segmentedMessageUserContent =
    segmentedPrompt && paramsWithAttachments.messages
      ? buildSegmentedUserContentForMessages(paramsWithAttachments)
      : undefined;
  const promptOrMessages: NativePrompt = paramsWithAttachments.messages
    ? wireMessages && wireMessages.length > 0
      ? segmentedMessageUserContent
        ? { messages: buildPlannerWireMessages(wireMessages, segmentedMessageUserContent) }
        : { messages: wireMessages }
      : {
          messages: [
            {
              role: "user" as const,
              content: userContent ?? resolved.prompt,
            },
          ],
        }
    : {
        messages: [
          {
            role: "user" as const,
            content: userContent ?? resolved.prompt,
          },
        ],
      };
  const generateParams: NativeTextParams = {
    model: anthropic(modelName),
    ...promptOrMessages,
    system,
    temperature: resolved.temperature,
    stopSequences: resolved.stopSequences as string[],
    frequencyPenalty: resolved.frequencyPenalty,
    presencePenalty: resolved.presencePenalty,
    experimental_telemetry: telemetryConfig,
    maxOutputTokens: resolved.maxTokens,
    topP: resolved.topP,
    ...(paramsWithAttachments.tools ? { tools: paramsWithAttachments.tools } : {}),
    ...(paramsWithAttachments.toolChoice ? { toolChoice: paramsWithAttachments.toolChoice } : {}),
    ...(paramsWithAttachments.responseSchema
      ? { output: buildStructuredOutput(paramsWithAttachments.responseSchema) }
      : {}),
    ...(anthropicProviderOptions
      ? { providerOptions: anthropicProviderOptions as NativeProviderOptions }
      : {}),
  };

  const operationName = `${modelType} request using ${modelName}`;

  if (params.stream) {
    try {
      const streamResult = streamText(generateParams);
      const usagePromise = Promise.resolve(streamResult.usage).then((usage) => {
        if (!usage) {
          return undefined;
        }

        emitModelUsageEvent(
          runtime,
          modelType,
          resolved.prompt,
          usage as AnthropicUsageWithCache,
          modelName
        );
        return normalizeAnthropicUsage(usage as AnthropicUsageWithCache);
      });
      const ignoreUsageError = (): undefined => undefined;
      async function* textStreamWithUsage(): AsyncIterable<string> {
        let completed = false;
        try {
          for await (const chunk of streamResult.textStream) {
            yield chunk;
          }
          completed = true;
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
    } catch (error) {
      throw formatModelError(operationName, error);
    }
  }

  try {
    const response = await executeWithRetry(operationName, () => generateText(generateParams));

    if (response.usage) {
      emitModelUsageEvent(
        runtime,
        modelType,
        resolved.prompt,
        response.usage as AnthropicUsageWithCache,
        modelName
      );
    }

    if (shouldReturnNativeResult) {
      return buildNativeTextResult(response) as unknown as string;
    }

    return response.text;
  } catch (error) {
    throw formatModelError(operationName, error);
  }
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const modelName = getSmallModel(runtime);
  return generateTextWithModel(runtime, params, modelName, "small", ModelType.TEXT_SMALL);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const modelName = getLargeModel(runtime);
  return generateTextWithModel(runtime, params, modelName, "large", ModelType.TEXT_LARGE);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getNanoModel(runtime),
    "small",
    TEXT_NANO_MODEL_TYPE
  );
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getMediumModel(runtime),
    "large",
    TEXT_MEDIUM_MODEL_TYPE
  );
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getMegaModel(runtime),
    "large",
    TEXT_MEGA_MODEL_TYPE
  );
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getResponseHandlerModel(runtime),
    "small",
    RESPONSE_HANDLER_MODEL_TYPE
  );
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getActionPlannerModel(runtime),
    "large",
    ACTION_PLANNER_MODEL_TYPE
  );
}

const TEXT_REASONING_SMALL_MODEL_TYPE = (ModelType.TEXT_REASONING_SMALL ??
  "REASONING_SMALL") as ModelTypeName;
const TEXT_REASONING_LARGE_MODEL_TYPE = (ModelType.TEXT_REASONING_LARGE ??
  "REASONING_LARGE") as ModelTypeName;

export async function handleReasoningSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getReasoningSmallModel(runtime),
    "small",
    TEXT_REASONING_SMALL_MODEL_TYPE
  );
}

export async function handleReasoningLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(
    runtime,
    params,
    getReasoningLargeModel(runtime),
    "large",
    TEXT_REASONING_LARGE_MODEL_TYPE
  );
}
