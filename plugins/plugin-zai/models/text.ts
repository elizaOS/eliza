import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createZaiClient, type ZaiFetch } from "../providers";
import type { ModelName, ModelSize, ProviderOptions } from "../types";
import {
  getExperimentalTelemetry,
  getLargeModel,
  getSmallModel,
  getThinkingConfig,
  type ZaiThinkingConfig,
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
  readonly thinking: ZaiThinkingConfig | null;
}

function resolveTextParams(
  params: GenerateTextParams,
  modelName: ModelName,
  thinking: ZaiThinkingConfig | null
): ResolvedTextParams {
  const prompt = params.prompt;
  const stopSequences = (params.stopSequences ?? []).slice(0, 1);
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;

  const rawParams = params as unknown as Record<string, unknown>;
  const topPExplicit = rawParams.topP != null;
  const temperature = params.temperature ?? 0.7;
  const topP = topPExplicit ? (params.topP ?? 0.9) : undefined;

  const defaultMaxTokens = modelName.includes("air") || modelName.includes("flash") ? 4096 : 8192;
  const maxTokens = params.maxTokens ?? defaultMaxTokens;

  const rawProviderOptions = rawParams.providerOptions as ProviderOptions | undefined;
  const providerOptions: ProviderOptions = rawProviderOptions
    ? JSON.parse(JSON.stringify(rawProviderOptions))
    : {};

  return {
    prompt,
    stopSequences,
    maxTokens,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    providerOptions,
    thinking,
  };
}

function createZaiRequestFetch(thinking: ZaiThinkingConfig | null, baseFetch: ZaiFetch): ZaiFetch {
  if (!thinking) {
    return baseFetch;
  }

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (!Object.hasOwn(body, "thinking")) {
          body.thinking = thinking;
          init.body = JSON.stringify(body);
        }
      } catch {
        // Non-JSON request bodies pass through unchanged.
      }
    }
    return baseFetch(input, init);
  };
  return Object.assign(wrapped, baseFetch) as ZaiFetch;
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelName: ModelName,
  modelSize: ModelSize,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE
): Promise<string> {
  const experimentalTelemetry = getExperimentalTelemetry(runtime);
  const thinking = getThinkingConfig(runtime, modelSize);
  const requestFetch = createZaiRequestFetch(thinking, (runtime.fetch ?? fetch) as ZaiFetch);
  const zai = createZaiClient(runtime, { fetch: requestFetch });

  logger.log(`[z.ai] Using ${modelType} model: ${modelName}`);

  const resolved = resolveTextParams(params, modelName, thinking);

  const agentName = resolved.providerOptions.agentName;
  const telemetryConfig = {
    isEnabled: experimentalTelemetry,
    functionId: agentName ? `agent:${agentName}` : undefined,
    metadata: agentName ? { agentName } : undefined,
  };

  const generateParams = {
    model: zai(modelName),
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

  const { text, usage } = await generateText(
    generateParams as unknown as Parameters<typeof generateText>[0]
  );

  if (usage) {
    emitModelUsageEvent(runtime, modelType, usage);
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
