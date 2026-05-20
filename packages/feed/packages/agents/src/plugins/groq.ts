/**
 * Groq Plugin for Feed Agents
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
import { GROQ_MODELS, type JsonValue } from "@feed/shared";
import { generateObject, generateText } from "ai";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
import { buildReasoningTraceMetadata } from "../llm/reasoning-trace";
import {
  ensureTrajectoryStep,
  type RuntimeTrajectoryLogger,
} from "../plugins/plugin-trajectory-logger/src/action-interceptor";
import { logger } from "../shared/logger";
import { isPromptLoggingEnabled, logPrompt } from "../utils/prompt-logger";

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
    process.env.GROQ_BASE_URL ||
    "https://api.groq.com/openai/v1"
  );
}

function resolveGroqRuntimeModel(
  runtime: IAgentRuntime,
  size: "small" | "large",
): string {
  const defaultSmall = GROQ_MODELS.FREE.modelId;
  const defaultLarge = GROQ_MODELS.PRO.modelId;

  if (size === "small") {
    return getStringSetting(runtime, "GROQ_SMALL_MODEL") || defaultSmall;
  }

  return (
    getStringSetting(runtime, "GROQ_LARGE_MODEL") ||
    getStringSetting(runtime, "GROQ_PRIMARY_MODEL") ||
    defaultLarge
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
    trajectoryLogger?: RuntimeTrajectoryLogger;
    trajectoryId?: string;
    purpose?: "action" | "reasoning" | "evaluation" | "response" | "other";
    actionType?: string;
    modelVersion?: string;
    runtime?: IAgentRuntime;
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

  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;
  let stepId: string | null = null;

  if (params.runtime) {
    const activeStep = await ensureTrajectoryStep(params.runtime);
    if (activeStep) {
      trajectoryLogger = activeStep.logger;
      trajectoryId = activeStep.trajectoryId;
      stepId = activeStep.stepId;
    }
  } else if (trajectoryLogger && trajectoryId) {
    stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  }

  if (trajectoryLogger && trajectoryId && stepId) {
    const reasoningMetadata = buildReasoningTraceMetadata(result.text);
    trajectoryLogger.logLLMCall(stepId, {
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
      ...reasoningMetadata,
    });
  }

  // Forward to DAG trace bridge if active
  try {
    const { getAgentLLMBridge } = require("@feed/shared");
    const bridge = getAgentLLMBridge();
    if (bridge) {
      bridge({
        provider: "groq",
        model,
        promptType: params.actionType || params.purpose || "agent-groq-plugin",
        format: "text",
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        systemPrompt: params.system || "",
        userPrompt: params.prompt,
        rawResponse: result.text,
        parsedResponse: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: latencyMs,
        success: true,
      });
    }
  } catch {
    // Bridge not available
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
  description: "Groq plugin for Feed agents",
  config: {
    GROQ_API_KEY: process.env.GROQ_API_KEY ?? null,
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
      {
        prompt,
        stopSequences = [],
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
        maxTokens = 8000,
      }: GenerateTextParams,
    ) => {
      const baseURL = getBaseURL(runtime);
      const groq = createGroq({
        apiKey: getStringSetting(runtime, "GROQ_API_KEY") ?? "",
        fetch: runtime.fetch ?? undefined,
        baseURL,
      });

      const model = resolveGroqRuntimeModel(runtime, "small");

      interface RuntimeWithExtensions extends IAgentRuntime {
        currentTrajectoryId?: string;
        currentModelVersion?: string;
      }
      const extendedRuntime = runtime as RuntimeWithExtensions;
      const modelVersion = extendedRuntime.currentModelVersion;

      return await generateGroqText(groq, model, {
        prompt,
        system: runtime.character.system ?? undefined,
        temperature,
        maxTokens,
        frequencyPenalty,
        presencePenalty,
        stopSequences,
        purpose: "action",
        modelVersion,
        runtime,
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

      const model = resolveGroqRuntimeModel(runtime, "large");

      type RuntimeWithTrajectory = typeof runtime & {
        currentTrajectoryId?: string;
        currentModelVersion?: string;
      };
      const runtimeWithTrajectory = runtime as RuntimeWithTrajectory;
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
        purpose: "action",
        modelVersion,
        runtime,
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
      const model = resolveGroqRuntimeModel(runtime, "small");

      return (await generateGroqObject(groq, model, params)) as Record<
        string,
        JsonValue
      >;
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
      const model = resolveGroqRuntimeModel(runtime, "large");

      return (await generateGroqObject(groq, model, params)) as Record<
        string,
        JsonValue
      >;
    },
  },
};
