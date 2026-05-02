/**
 * Text generation model handlers
 *
 * Provides text generation using OpenAI's language models.
 */

import type { GenerateTextParams, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type LanguageModelUsage, streamText } from "ai";
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

interface GenerateTextParamsWithOpenAIOptions extends GenerateTextParams {
  attachments?: ChatAttachment[];
  providerOptions?: {
    openai?: OpenAIPromptCacheOptions;
  };
}

interface LanguageModelUsageWithCache extends LanguageModelUsage {
  cachedInputTokens?: number;
}

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

function buildUserContent(params: GenerateTextParamsWithOpenAIOptions) {
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
 * Converts AI SDK usage to our token usage format
 */
function convertUsage(usage: LanguageModelUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  // The AI SDK uses inputTokens/outputTokens
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const usageWithCache = usage as LanguageModelUsageWithCache;

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: usageWithCache.cachedInputTokens,
  };
}

function resolvePromptCacheOptions(params: GenerateTextParams): OpenAIPromptCacheOptions {
  const withOpenAIOptions = params as GenerateTextParamsWithOpenAIOptions;
  return {
    promptCacheKey: withOpenAIOptions.providerOptions?.openai?.promptCacheKey,
    promptCacheRetention: withOpenAIOptions.providerOptions?.openai?.promptCacheRetention,
  };
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
  const paramsWithAttachments = params as GenerateTextParamsWithOpenAIOptions;
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);
  const promptCacheOptions = resolvePromptCacheOptions(params);
  const hasAttachments = (paramsWithAttachments.attachments?.length ?? 0) > 0;
  const userContent = hasAttachments ? buildUserContent(paramsWithAttachments) : undefined;

  // Get system prompt from character if available
  const systemPrompt = runtime.character.system ?? undefined;

  // Use chat() instead of languageModel() to use the Chat Completions API
  // which has better compatibility than the Responses API
  // gpt-5 and gpt-5-mini (reasoning models) don't support temperature,
  // frequencyPenalty, presencePenalty, or stop parameters - use defaults only
  const model = openai.chat(modelName);
  const generateParams = {
    model,
    ...(userContent
      ? { messages: [{ role: "user" as const, content: userContent }] }
      : { prompt: params.prompt }),
    system: systemPrompt,
    maxOutputTokens: params.maxTokens ?? 8192,
    experimental_telemetry: { isEnabled: getExperimentalTelemetry(runtime) },
    ...(promptCacheOptions.promptCacheKey || promptCacheOptions.promptCacheRetention
      ? {
          providerOptions: {
            openai: {
              ...(promptCacheOptions.promptCacheKey
                ? { promptCacheKey: promptCacheOptions.promptCacheKey }
                : {}),
              ...(promptCacheOptions.promptCacheRetention
                ? { promptCacheRetention: promptCacheOptions.promptCacheRetention }
                : {}),
            },
          },
        }
      : {}),
  };

  // Handle streaming mode
  if (params.stream) {
    const result = streamText(generateParams);

    return {
      textStream: result.textStream,
      text: Promise.resolve(result.text),
      usage: Promise.resolve(result.usage).then(convertUsage),
      finishReason: Promise.resolve(result.finishReason).then((r) => r as string | undefined),
    };
  }

  // Non-streaming mode
  const { text, usage } = await generateText(generateParams);

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage);
  }

  return text;
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
