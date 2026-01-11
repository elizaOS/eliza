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
import { getExperimentalTelemetry, getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

// ============================================================================
// Types
// ============================================================================

/**
 * Function to get model name from runtime
 */
type ModelNameGetter = (runtime: IAgentRuntime) => string;

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

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
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
  const openai = createOpenAIClient(runtime);
  const modelName = getModelFn(runtime);

  logger.debug(`[OpenAI] Using ${modelType} model: ${modelName}`);

  // Get system prompt from character if available
  const systemPrompt = runtime.character.system ?? undefined;

  // Use chat() instead of languageModel() to use the Chat Completions API
  // which has better compatibility than the Responses API
  // gpt-5 and gpt-5-mini (reasoning models) don't support temperature,
  // frequencyPenalty, presencePenalty, or stop parameters - use defaults only
  const model = openai.chat(modelName);
  const generateParams = {
    model,
    prompt: params.prompt,
    system: systemPrompt,
    maxOutputTokens: params.maxTokens ?? 8192,
    experimental_telemetry: { isEnabled: getExperimentalTelemetry(runtime) },
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
