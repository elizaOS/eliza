/**
 * Groq Plugin for Polyagent Agents
 *
 * Provides access to Groq's fast LLM inference for agent decision-making.
 * Supports both small and large models with automatic trajectory logging.
 *
 * @packageDocumentation
 */

import { createGroq } from "@ai-sdk/groq";
import type {
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
  Plugin,
} from "@elizaos/core";
import {
  type DetokenizeTextParams,
  type GenerateTextParams,
  ModelType,
  type TokenizeTextParams,
} from "@elizaos/core";
import { GROQ_MODELS } from "@polyagent/shared";
import { generateObject, generateText } from "ai";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
import { logger } from "../shared/logger";
import { isPromptLoggingEnabled, logPrompt } from "../utils/prompt-logger";
import type { TrajectoryLoggerService } from "./plugin-trajectory-logger/src/TrajectoryLoggerService";

function getStringSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Gets Groq base URL from runtime settings
 * @internal
 */
function getBaseURL(runtime: IAgentRuntime): string {
  return (
    getStringSetting(runtime, "GROQ_BASE_URL") ||
    "https://api.groq.com/openai/v1"
  );
}

/**
 * Finds model name for tokenization
 * @internal
 */
function findModelName(model: ModelTypeName): TiktokenModel {
  const name =
    model === ModelType.TEXT_SMALL
      ? GROQ_MODELS.FREE.modelId
      : GROQ_MODELS.PRO.modelId;
  return name as TiktokenModel;
}

/**
 * Tokenizes text using tiktoken
 * @internal
 */
async function tokenizeText(model: ModelTypeName, prompt: string) {
  const encoding = encodingForModel(findModelName(model));
  const tokens = encoding.encode(prompt);
  return tokens;
}

/**
 * Detokenizes tokens back to text
 * @internal
 */
async function detokenizeText(model: ModelTypeName, tokens: number[]) {
  const modelName = findModelName(model);
  const encoding = encodingForModel(modelName);
  return encoding.decode(tokens);
}

/**
 * Generates text using Groq API
 * @internal
 */
async function generateGroqText(
  groq: ReturnType<typeof createGroq>,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
    trajectoryLogger?: TrajectoryLoggerService;
    trajectoryId?: string;
    purpose?: "action" | "reasoning" | "evaluation" | "response" | "other";
    actionType?: string;
    modelVersion?: string;
  },
) {
  const startTime = Date.now();
  const result = await generateText({
    model: groq.languageModel(model),
    prompt: params.prompt,
    system: params.system,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: params.stopSequences,
  });
  const latencyMs = Date.now() - startTime;

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: params.actionType || params.purpose || "groq_plugin_text",
      input: `System: ${params.system || ""}\n\nUser: ${params.prompt}`,
      output: result.text,
      metadata: {
        provider: "groq_plugin",
        model,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      },
    });
  }

  if (params.trajectoryLogger && params.trajectoryId) {
    const stepId = params.trajectoryLogger.getCurrentStepId(
      params.trajectoryId,
    );
    if (stepId) {
      params.trajectoryLogger.logLLMCall(stepId, {
        model,
        modelVersion: params.modelVersion,
        systemPrompt: params.system || "",
        userPrompt: params.prompt,
        response: result.text,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        purpose: params.purpose || "action",
        actionType: params.actionType,
        latencyMs,
        promptTokens: undefined,
        completionTokens: undefined,
      });
    }
  }

  return result.text;
}

/**
 * Generates structured object using Groq API
 * @internal
 */
async function generateGroqObject(
  groq: ReturnType<typeof createGroq>,
  model: string,
  params: ObjectGenerationParams,
) {
  const { object } = await generateObject({
    model: groq.languageModel(model),
    output: "no-schema",
    prompt: params.prompt,
    temperature: params.temperature,
  });

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: "groq_plugin_object",
      input: params.prompt,
      output: JSON.stringify(object, null, 2),
      metadata: {
        provider: "groq_plugin",
        model,
        temperature: params.temperature,
      },
    });
  }

  if (typeof object === "object" && object !== null && !Array.isArray(object)) {
    return object as Record<string, unknown>;
  }

  return { value: object } satisfies Record<string, unknown>;
}

export const groqPlugin: Plugin = {
  name: "groq",
  description: "Groq plugin for Polyagent agents",
  config: {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_SMALL_MODEL: GROQ_MODELS.FREE.modelId,
    GROQ_LARGE_MODEL: GROQ_MODELS.PRO.modelId,
  },
  async init() {
    if (!process.env.GROQ_API_KEY) {
      throw Error("Missing GROQ_API_KEY in environment variables");
    }
  },
  models: {
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime,
      { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams,
    ) => {
      return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime,
      { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams,
    ) => {
      return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
    },
    [ModelType.TEXT_SMALL]: async (
      runtime,
      { prompt, stopSequences = [] }: GenerateTextParams,
    ) => {
      const temperature = 0.7;
      const frequency_penalty = 0.7;
      const presence_penalty = 0.7;
      const max_response_length = 8000;
      const baseURL = getBaseURL(runtime);
      const groq = createGroq({
        apiKey: getStringSetting(runtime, "GROQ_API_KEY") ?? "",
        fetch: runtime.fetch ?? undefined,
        baseURL,
      });

      const model = GROQ_MODELS.FREE.modelId;

      interface RuntimeWithExtensions extends IAgentRuntime {
        trajectoryLogger?: TrajectoryLoggerService;
        currentTrajectoryId?: string;
        currentModelVersion?: string;
      }
      const extendedRuntime = runtime as RuntimeWithExtensions;
      const trajectoryLogger = extendedRuntime.trajectoryLogger;
      const trajectoryId = extendedRuntime.currentTrajectoryId;
      const modelVersion = extendedRuntime.currentModelVersion;

      return await generateGroqText(groq, model, {
        prompt,
        system: runtime.character.system ?? undefined,
        temperature,
        maxTokens: max_response_length,
        frequencyPenalty: frequency_penalty,
        presencePenalty: presence_penalty,
        stopSequences,
        trajectoryLogger,
        trajectoryId,
        purpose: "action",
        modelVersion,
      });
    },
    [ModelType.TEXT_LARGE]: async (
      runtime,
      {
        prompt,
        stopSequences = [],
        maxTokens = 8192,
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
      }: GenerateTextParams,
    ) => {
      const baseURL = getBaseURL(runtime);
      const apiKey = getStringSetting(runtime, "GROQ_API_KEY") ?? "";

      const groq = createGroq({
        apiKey,
        fetch: runtime.fetch ?? undefined,
        baseURL,
      });

      const model = GROQ_MODELS.PRO.modelId;

      type RuntimeWithTrajectory = typeof runtime & {
        trajectoryLogger?: TrajectoryLoggerService;
        currentTrajectoryId?: string;
        currentModelVersion?: string;
      };
      const runtimeWithTrajectory = runtime as RuntimeWithTrajectory;
      const trajectoryLogger = runtimeWithTrajectory.trajectoryLogger;
      const trajectoryId = runtimeWithTrajectory.currentTrajectoryId;
      const modelVersion = runtimeWithTrajectory.currentModelVersion;

      logger.debug(
        "Using Groq model for inference",
        {
          model,
          modelSource: "groq",
        },
        "GroqPlugin",
      );

      return await generateGroqText(groq, model, {
        prompt,
        system: runtime.character.system ?? undefined,
        temperature,
        maxTokens,
        frequencyPenalty,
        presencePenalty,
        stopSequences,
        trajectoryLogger,
        trajectoryId,
        purpose: "action",
        modelVersion,
      });
    },
    [ModelType.OBJECT_SMALL]: async (
      runtime,
      params: ObjectGenerationParams,
    ) => {
      const baseURL = getBaseURL(runtime);
      const groq = createGroq({
        apiKey: getStringSetting(runtime, "GROQ_API_KEY") ?? "",
        fetch: runtime.fetch ?? undefined,
        baseURL,
      });
      const model = GROQ_MODELS.FREE.modelId;

      return await generateGroqObject(groq, model, params);
    },
    [ModelType.OBJECT_LARGE]: async (
      runtime,
      params: ObjectGenerationParams,
    ) => {
      const baseURL = getBaseURL(runtime);
      const groq = createGroq({
        apiKey: getStringSetting(runtime, "GROQ_API_KEY") ?? "",
        fetch: runtime.fetch ?? undefined,
        baseURL,
      });
      const model = GROQ_MODELS.PRO.modelId;

      return await generateGroqObject(groq, model, params);
    },
  },
};
