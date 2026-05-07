import type { GenerateTextParams, IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider";

import {
  getActionPlannerModel,
  getBaseURL,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsed, estimateUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { ensureModelAvailable } from "./availability";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;

type GenerateTextParamsWithNativeOptions = GenerateTextParams & {
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  responseSchema?: unknown;
};

function assertNoUnsupportedNativeOptions(params: GenerateTextParamsWithNativeOptions): void {
  const unsupported = [
    params.messages ? "messages" : undefined,
    params.tools ? "tools" : undefined,
    params.toolChoice ? "toolChoice" : undefined,
    params.responseSchema ? "responseSchema" : undefined,
  ].filter((name): name is string => Boolean(name));

  if (unsupported.length > 0) {
    throw new Error(
      `[Ollama] Native ${unsupported.join(", ")} plumbing is not supported by this adapter yet.`
    );
  }
}

async function generateOllamaText(
  runtime: IAgentRuntime,
  ollama: ReturnType<typeof createOllama>,
  modelType: TextModelType,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
  }
): Promise<string> {
  try {
    const generateParams = {
      // ollama-ai-provider still exposes older AI SDK model interfaces.
      model: ollama(model) as unknown as LanguageModel,
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences,
    };

    const { text: ollamaResponse, usage } = await generateText(generateParams);
    emitModelUsed(
      runtime,
      modelType,
      model,
      normalizeTokenUsage(usage) ?? estimateUsage(params.prompt, ollamaResponse)
    );
    return ollamaResponse;
  } catch (error: unknown) {
    logger.error({ error }, "Error in generateOllamaText");
    return "Error generating text. Please try again later.";
  }
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

async function handleTextWithModelType(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string> {
  assertNoUnsupportedNativeOptions(params as GenerateTextParamsWithNativeOptions);

  const {
    prompt,
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    frequencyPenalty = 0.7,
    presencePenalty = 0.7,
  } = params;

  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = runtime.fetch ?? undefined;
    const ollama = createOllama({
      fetch: customFetch,
      baseURL,
    });

    const model = getModelNameForType(runtime, modelType);
    logger.log(`[Ollama] Using ${modelType} model: ${model}`);
    await ensureModelAvailable(model, baseURL, customFetch);

    return await generateOllamaText(runtime, ollama, modelType, model, {
      prompt,
      system: runtime.character?.system ?? undefined,
      temperature,
      maxTokens,
      frequencyPenalty,
      presencePenalty,
      stopSequences,
    });
  } catch (error) {
    logger.error({ error }, `Error in ${modelType} model`);
    return "Error generating text. Please try again later.";
  }
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, ModelType.TEXT_SMALL, params);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, TEXT_NANO_MODEL_TYPE, params);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, TEXT_MEDIUM_MODEL_TYPE, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, ModelType.TEXT_LARGE, params);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, TEXT_MEGA_MODEL_TYPE, params);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, RESPONSE_HANDLER_MODEL_TYPE, params);
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextWithModelType(runtime, ACTION_PLANNER_MODEL_TYPE, params);
}
