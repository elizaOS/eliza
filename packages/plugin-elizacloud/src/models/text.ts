import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createOpenAIClient } from "../providers/openai";
import {
  getSmallModel,
  getLargeModel,
  getExperimentalTelemetry,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

/**
 * TEXT_SMALL model handler
 */
export async function handleTextSmall(
  runtime: IAgentRuntime,
  {
    prompt,
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  }: GenerateTextParams,
): Promise<string> {
  const openai = createOpenAIClient(runtime);
  const modelName = getSmallModel(runtime);
  const experimentalTelemetry = getExperimentalTelemetry(runtime);

  logger.log(`[ELIZAOS_CLOUD] Using TEXT_SMALL model: ${modelName}`);
  logger.log(prompt);

  const { text: openaiResponse, usage } = await generateText({
    model: openai.languageModel(modelName),
    prompt: prompt,
    system: runtime.character.system ?? undefined,
    temperature: temperature,
    maxOutputTokens: maxTokens,
    frequencyPenalty: frequencyPenalty,
    presencePenalty: presencePenalty,
    stopSequences: stopSequences,
    experimental_telemetry: {
      isEnabled: experimentalTelemetry,
    },
  });

  if (usage) {
    emitModelUsageEvent(runtime, ModelType.TEXT_SMALL, prompt, usage);
  }

  return openaiResponse;
}

/**
 * TEXT_LARGE model handler
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  {
    prompt,
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  }: GenerateTextParams,
): Promise<string> {
  const openai = createOpenAIClient(runtime);
  const modelName = getLargeModel(runtime);
  const experimentalTelemetry = getExperimentalTelemetry(runtime);

  logger.log(`[ELIZAOS_CLOUD] Using TEXT_LARGE model: ${modelName}`);
  logger.log(prompt);

  const { text: openaiResponse, usage } = await generateText({
    model: openai.languageModel(modelName),
    prompt: prompt,
    system: runtime.character.system ?? undefined,
    temperature: temperature,
    maxOutputTokens: maxTokens,
    frequencyPenalty: frequencyPenalty,
    presencePenalty: presencePenalty,
    stopSequences: stopSequences,
    experimental_telemetry: {
      isEnabled: experimentalTelemetry,
    },
  });

  if (usage) {
    emitModelUsageEvent(runtime, ModelType.TEXT_LARGE, prompt, usage);
  }

  return openaiResponse;
}
