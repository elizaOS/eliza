/**
 * The `TEXT_SMALL` / `TEXT_LARGE` handlers backing the plugin's model map.
 * Each resolves the configured model name, builds a NEAR AI client, runs the
 * Vercel AI SDK `generateText`, and emits a `MODEL_USED` event with token usage.
 *
 * NEAR AI's OpenAI-compatible endpoint diverges from OpenAI proper, so
 * `createNearAIRequestFetch` wraps the request fetch to normalise each JSON body
 * before it leaves: `max_completion_tokens` → `max_tokens` (without clobbering an
 * explicit `max_tokens`), the `store` / `reasoning_effort` / `strict` fields are
 * dropped, and any `developer`-role message is rewritten to `system`. Update
 * that shim if the upstream API changes what it accepts.
 */
import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger, ModelType } from "@elizaos/core";
import { generateText, type ToolSet } from "ai";
import { createNearAIClient, type NearAIFetch } from "../providers";
import type { ModelName, ProviderOptions } from "../types";
import {
  getApiKey,
  getExperimentalTelemetry,
  getLargeModel,
  getSmallModel,
  isBrowser,
} from "../utils/config";
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
        // error-policy:J3 untrusted-input sanitizing — the compatibility shim
        // can only rewrite a JSON body; non-JSON request bodies pass through
        // unchanged rather than being replaced with a fabricated one.
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
  // A missing credential must surface as a typed local failure before any
  // request goes out — an anonymous request would masquerade as a
  // provider-side 401 and hide the real misconfiguration. Browser builds are
  // exempt: they route through a proxy that holds the key
  // (NEARAI_BROWSER_BASE_URL).
  if (!isBrowser()) {
    getApiKey(runtime);
  }
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

  const { text, usage, finishReason } = await generateText(generateParams);

  // An empty completion is a provider failure (moderation, truncation,
  // upstream bug) — never a legitimate result for this prompt-only handler.
  // Returning "" would fabricate a healthy-empty completion the planner
  // cannot distinguish from a real answer, and emit success usage telemetry
  // for it (#9324: throw, never fabricate).
  if (text.length === 0) {
    throw new ElizaError(
      `[NEAR AI] ${modelType} returned an empty completion${
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
