/**
 * Core text generation for the z.ai handlers. `resolveTextParams` maps
 * `GenerateTextParams` to the AI SDK call — selecting the per-size model, caching
 * per-size max-token caps (4096 for `air`/`flash`, 8192 otherwise), and folding
 * in the resolved thinking config. `generateTextWithModel` runs the call and
 * emits `MODEL_USED` with token usage.
 *
 * Thinking mode is injected at the HTTP fetch layer via `createZaiRequestFetch`
 * rather than as an AI SDK parameter, because z.ai's OpenAI-compatible endpoint
 * expects a top-level `thinking` body field the SDK does not natively emit.
 */
import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createZaiClient, type ZaiFetch } from "../providers";
import { createModelName, type ModelName, type ModelSize, type ProviderOptions } from "../types";
import {
  getApiKey,
  getExperimentalTelemetry,
  getLargeModel,
  getSmallModel,
  getThinkingConfig,
  isBrowser,
  type ZaiThinkingConfig,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

interface ResolvedTextParams {
  readonly prompt: string;
  readonly stopSequences: readonly string[];
  readonly maxTokens?: number;
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly frequencyPenalty: number;
  readonly presencePenalty: number;
  readonly providerOptions: ProviderOptions;
  readonly thinking: ZaiThinkingConfig | null;
}

function resolveRequestedModelName(params: GenerateTextParams, fallback: ModelName): ModelName {
  const requestedModel = (params as GenerateTextParams & { model?: unknown }).model;
  return typeof requestedModel === "string" && requestedModel.trim().length > 0
    ? createModelName(requestedModel.trim())
    : fallback;
}

function resolveTextParams(
  params: GenerateTextParams,
  modelName: ModelName,
  thinking: ZaiThinkingConfig | null
): ResolvedTextParams {
  const prompt = params.prompt ?? "";
  const stopSequences = (params.stopSequences ?? []).slice(0, 1);
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;

  const rawParams = params as unknown as Record<string, unknown>;
  const topPExplicit = rawParams.topP != null;
  const temperature = params.temperature ?? 0.7;
  const topP = topPExplicit ? (params.topP ?? 0.9) : undefined;

  const defaultMaxTokens = modelName.includes("air") || modelName.includes("flash") ? 4096 : 8192;
  const maxTokens = params.omitMaxTokens ? undefined : (params.maxTokens ?? defaultMaxTokens);

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
        // error-policy:J3 untrusted-input sanitizing — the thinking field is
        // only injectable into a JSON body; non-JSON request bodies pass
        // through unchanged rather than being replaced with a fabricated one.
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
  // A missing credential must surface as a typed local failure before any
  // request goes out — an anonymous request would masquerade as a
  // provider-side 401 and hide the real misconfiguration. Browser builds are
  // exempt: they route through a proxy that holds the key
  // (ZAI_BROWSER_BASE_URL).
  if (!isBrowser()) {
    getApiKey(runtime);
  }
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
    topP: resolved.topP,
    ...(typeof resolved.maxTokens === "number" ? { maxTokens: resolved.maxTokens } : {}),
  };

  const { text, usage, finishReason } = await generateText(
    generateParams as Parameters<typeof generateText>[0]
  );

  // An empty completion is a provider failure (moderation, truncation,
  // upstream bug) — never a legitimate result for this prompt-only handler.
  // Returning "" would fabricate a healthy-empty completion the planner
  // cannot distinguish from a real answer, and emit success usage telemetry
  // for it (#9324: throw, never fabricate).
  if (text.length === 0) {
    throw new ElizaError(
      `[z.ai] ${modelType} returned an empty completion${
        finishReason ? ` (finishReason: ${finishReason})` : ""
      }`,
      {
        code: "MODEL_EMPTY_COMPLETION",
        context: { modelType, modelName, finishReason },
      }
    );
  }

  if (usage) {
    emitModelUsageEvent(runtime, modelType, usage);
  }

  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const modelName = resolveRequestedModelName(params, getSmallModel(runtime));
  return generateTextWithModel(runtime, params, modelName, "small", ModelType.TEXT_SMALL);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const modelName = resolveRequestedModelName(params, getLargeModel(runtime));
  return generateTextWithModel(runtime, params, modelName, "large", ModelType.TEXT_LARGE);
}
