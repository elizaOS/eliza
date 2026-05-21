import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createNearAIClient, type NearAIFetch } from "../providers";
import type { ModelName, ProviderOptions } from "../types";
import { getExperimentalTelemetry, getLargeModel, getSmallModel } from "../utils/config";
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

function resolveTextParams(params: GenerateTextParams): ResolvedTextParams {
  const prompt = params.prompt ?? "";
  const stopSequences = params.stopSequences ?? [];
  const frequencyPenalty = params.frequencyPenalty ?? 0;
  const presencePenalty = params.presencePenalty ?? 0;

  const rawParams = params as unknown as Record<string, unknown>;
  const temperature = params.temperature;
  const topP = rawParams.topP != null ? params.topP : undefined;
  const maxTokens = params.maxTokens ?? 8192;

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
  };
}

function createNearAIRequestFetch(baseFetch: NearAIFetch): NearAIFetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.max_completion_tokens != null && body.max_tokens == null) {
          body.max_tokens = body.max_completion_tokens;
        }
        delete body.max_completion_tokens;
        delete body.store;
        delete body.reasoning_effort;
        delete body.strict;
        if (Array.isArray(body.messages)) {
          body.messages = body.messages.map((message) => {
            if (
              message &&
              typeof message === "object" &&
              (message as { role?: unknown }).role === "developer"
            ) {
              return { ...(message as Record<string, unknown>), role: "system" };
            }
            return message;
          });
        }
        init.body = JSON.stringify(body);
      } catch {
        // Non-JSON request bodies pass through unchanged.
      }
    }
    return baseFetch(input, init);
  };
  return Object.assign(wrapped, baseFetch) as NearAIFetch;
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelName: ModelName,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE
): Promise<string> {
  const experimentalTelemetry = getExperimentalTelemetry(runtime);
  const requestFetch = createNearAIRequestFetch((runtime.fetch ?? fetch) as NearAIFetch);
  const nearai = createNearAIClient(runtime, { fetch: requestFetch });

  logger.log(`[NEAR AI] Using ${modelType} model: ${modelName}`);

  const resolved = resolveTextParams(params);

  const agentName = resolved.providerOptions.agentName;
  const telemetryConfig = {
    isEnabled: experimentalTelemetry,
    functionId: agentName ? `agent:${agentName}` : undefined,
    metadata: agentName ? { agentName } : undefined,
  };

  const generateParams = {
    model: nearai(modelName),
    prompt: resolved.prompt,
    system: runtime.character?.system ?? undefined,
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
  return generateTextWithModel(runtime, params, modelName, ModelType.TEXT_SMALL);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const modelName = getLargeModel(runtime);
  return generateTextWithModel(runtime, params, modelName, ModelType.TEXT_LARGE);
}
