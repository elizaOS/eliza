import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createAnthropicClientWithTopPSupport } from "../providers";
import type { ModelName, ModelSize, ProviderOptions } from "../types";
import {
  getCoTBudget,
  getExperimentalTelemetry,
  getLargeModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

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

function resolveTextParams(
  params: GenerateTextParams,
  modelName: ModelName,
  cotBudget: number
): ResolvedTextParams {
  const prompt = params.prompt;
  const stopSequences = params.stopSequences ?? [];
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;

  const rawParams = params as unknown as Record<string, unknown>;
  const topPExplicit = "topP" in rawParams;
  const temperatureExplicit = "temperature" in rawParams;

  if (topPExplicit && temperatureExplicit) {
    throw new Error(
      "Cannot use both temperature and topP parameters simultaneously. " +
        "Anthropic's API only supports one at a time. Please provide only one."
    );
  }

  let temperature: number | undefined;
  let topP: number | undefined;

  if (topPExplicit) {
    topP = params.topP ?? 0.9;
    temperature = undefined;
  } else {
    temperature = params.temperature ?? 0.7;
    topP = undefined;
  }

  const defaultMaxTokens = modelName.includes("-3-") ? 4096 : 8192;
  const maxTokens = params.maxTokens ?? defaultMaxTokens;

  const rawProviderOptions = rawParams["providerOptions"] as ProviderOptions | undefined;
  const providerOptions: ProviderOptions = rawProviderOptions
    ? JSON.parse(JSON.stringify(rawProviderOptions))
    : {};

  if (cotBudget > 0) {
    const existingAnthropic = providerOptions.anthropic ?? {};
    (providerOptions as { anthropic: Record<string, unknown> }).anthropic = {
      ...existingAnthropic,
      thinking: { type: "enabled", budgetTokens: cotBudget },
    };
  }

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
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE
): Promise<string> {
  const anthropic = createAnthropicClientWithTopPSupport(runtime);
  const experimentalTelemetry = getExperimentalTelemetry(runtime);
  const cotBudget = getCoTBudget(runtime, modelSize);

  logger.log(`[Anthropic] Using ${modelType} model: ${modelName}`);

  const resolved = resolveTextParams(params, modelName, cotBudget);

  const agentName = resolved.providerOptions.agentName;
  const telemetryConfig = {
    isEnabled: experimentalTelemetry,
    functionId: agentName ? `agent:${agentName}` : undefined,
    metadata: agentName ? { agentName } : undefined,
  };

  const generateParams = {
    model: anthropic(modelName),
    prompt: resolved.prompt,
    system: runtime.character.system ?? undefined,
    temperature: resolved.temperature,
    stopSequences: resolved.stopSequences as string[],
    frequencyPenalty: resolved.frequencyPenalty,
    presencePenalty: resolved.presencePenalty,
    experimental_telemetry: telemetryConfig,
    maxTokens: resolved.maxTokens,
    topP: resolved.topP,
  };

  const { text, usage } = await generateText(generateParams as Parameters<typeof generateText>[0]);

  if (usage) {
    emitModelUsageEvent(runtime, modelType, resolved.prompt, usage);
  }

  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const modelName = getSmallModel(runtime);
  return generateTextWithModel(runtime, params, modelName, "small", ModelType.TEXT_SMALL);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const modelName = getLargeModel(runtime);
  return generateTextWithModel(runtime, params, modelName, "large", ModelType.TEXT_LARGE);
}
