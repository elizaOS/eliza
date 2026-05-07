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
import { logger, ModelType, recordLlmCall } from "@elizaos/core";
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
  messages?: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
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
  NativePrompt;
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
  const withOpenAIOptions = params as unknown as GenerateTextParamsWithOpenAIOptions;
  return {
    promptCacheKey: withOpenAIOptions.providerOptions?.openai?.promptCacheKey,
    promptCacheRetention: withOpenAIOptions.providerOptions?.openai?.promptCacheRetention,
  };
}

function resolveProviderOptions(
  params: GenerateTextParams,
  runtime: IAgentRuntime
): Record<string, unknown> | undefined {
  const withOpenAIOptions = params as unknown as GenerateTextParamsWithOpenAIOptions;
  const rawProviderOptions = withOpenAIOptions.providerOptions;
  const promptCacheOptions = resolvePromptCacheOptions(params);

  if (
    !rawProviderOptions &&
    !promptCacheOptions.promptCacheKey &&
    !promptCacheOptions.promptCacheRetention
  ) {
    return undefined;
  }

  // `prompt_cache_retention` is an OpenAI-direct field not supported by
  // OpenAI-compatible providers such as Cerebras. Skip it when in Cerebras mode
  // so we don't send an unsupported field that causes HTTP 400 errors.
  const skipCacheRetention = isCerebrasMode(runtime);

  const { agentName: _agentName, openai: rawOpenAIOptions, ...rest } = rawProviderOptions ?? {};
  const openaiOptions = {
    ...(rawOpenAIOptions ?? {}),
    ...(promptCacheOptions.promptCacheKey
      ? { promptCacheKey: promptCacheOptions.promptCacheKey }
      : {}),
    ...(!skipCacheRetention && promptCacheOptions.promptCacheRetention
      ? { promptCacheRetention: promptCacheOptions.promptCacheRetention }
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
    schema: jsonSchema(schemaOptions.schema as JSONSchema7),
    ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
    ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
  }) as NativeOutput;
}

function usesNativeTextResult(params: GenerateTextParamsWithOpenAIOptions): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

function buildNativeTextResult(result: {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: LanguageModelUsage;
  providerMetadata?: unknown;
}): NativeGenerateTextResult {
  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    usage: convertUsage(result.usage),
    providerMetadata: result.providerMetadata,
  };
}

function createLlmCallDetails(
  modelName: string,
  params: GenerateTextParams,
  systemPrompt: string | undefined,
  actionType: string,
  modelType?: ModelTypeName,
  providerOptions?: Record<string, unknown>
): RecordLlmCallDetails {
  const nativeParams = params as unknown as GenerateTextParamsWithOpenAIOptions;
  return {
    model: modelName,
    modelType,
    provider: "vercel-ai-sdk",
    systemPrompt: systemPrompt ?? "",
    userPrompt: params.prompt,
    prompt: params.prompt,
    messages: Array.isArray(nativeParams.messages) ? nativeParams.messages : undefined,
    tools: nativeParams.tools,
    toolChoice: nativeParams.toolChoice,
    responseSchema: nativeParams.responseSchema,
    providerOptions: providerOptions ?? nativeParams.providerOptions,
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens ?? 8192,
    purpose: "external_llm",
    actionType,
  };
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
  const paramsWithAttachments = params as unknown as GenerateTextParamsWithOpenAIOptions;
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);
  const providerOptions = resolveProviderOptions(params, runtime);
  const hasAttachments = (paramsWithAttachments.attachments?.length ?? 0) > 0;
  const userContent = hasAttachments ? buildUserContent(paramsWithAttachments) : undefined;
  const shouldReturnNativeResult = usesNativeTextResult(paramsWithAttachments);

  // Get system prompt from character if available
  const systemPrompt = runtime.character.system ?? undefined;
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
  const promptOrMessages: NativePrompt = paramsWithAttachments.messages
    ? { messages: paramsWithAttachments.messages }
    : userContent
      ? { messages: [{ role: "user" as const, content: userContent }] }
      : { prompt: params.prompt };
  const generateParams: NativeTextParams = {
    model,
    ...promptOrMessages,
    system: systemPrompt,
    maxOutputTokens: params.maxTokens ?? 8192,
    experimental_telemetry: telemetryConfig,
    ...(paramsWithAttachments.tools ? { tools: paramsWithAttachments.tools } : {}),
    ...(paramsWithAttachments.toolChoice ? { toolChoice: paramsWithAttachments.toolChoice } : {}),
    ...(paramsWithAttachments.responseSchema
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
      providerOptions
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
    providerOptions
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
    emitModelUsageEvent(runtime, modelType, params.prompt, result.usage);
  }

  if (shouldReturnNativeResult) {
    return buildNativeTextResult(result) as unknown as string;
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
