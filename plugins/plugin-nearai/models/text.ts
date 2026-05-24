import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText, type ToolSet } from "ai";
import { createNearAIClient, type NearAIFetch } from "../providers";
import type { ModelName, ProviderOptions } from "../types";
import { getExperimentalTelemetry, getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

// Extract the native generateText parameter type to avoid unsafe casts at call sites.
type NativeGenerateTextParams = Parameters<typeof generateText<ToolSet>>[0];

interface ResolvedTextParams {
  readonly prompt: string;
  readonly stopSequences: readonly string[];
  readonly maxOutputTokens: number;
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly frequencyPenalty: number;
  readonly presencePenalty: number;
  readonly providerOptions: ProviderOptions;
}

function resolveTextParams(params: GenerateTextParams): ResolvedTextParams {
  // All fields read here are direct properties of GenerateTextParams — no cast needed.
  const providerOptions: ProviderOptions =
    (params.providerOptions?.nearai as ProviderOptions | undefined) ?? {};

  return {
    prompt: params.prompt ?? "",
    stopSequences: params.stopSequences ?? [],
    maxOutputTokens: params.maxTokens ?? 8192,
    temperature: params.temperature,
    topP: params.topP,
    frequencyPenalty: params.frequencyPenalty ?? 0,
    presencePenalty: params.presencePenalty ?? 0,
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

  const generateParams: NativeGenerateTextParams = {
    model: nearai(modelName),
    prompt: resolved.prompt,
    system: runtime.character?.system ?? undefined,
    temperature: resolved.temperature,
    stopSequences: resolved.stopSequences as string[],
    frequencyPenalty: resolved.frequencyPenalty,
    presencePenalty: resolved.presencePenalty,
    experimental_telemetry: telemetryConfig,
    maxOutputTokens: resolved.maxOutputTokens,
    topP: resolved.topP,
  };

  const { text, usage } = await generateText(generateParams);

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
