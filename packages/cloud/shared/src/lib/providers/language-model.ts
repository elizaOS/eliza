// Defines cloud shared language model behavior for backend service consumers.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, type LanguageModelMiddleware, RetryError, wrapLanguageModel } from "ai";
import {
  BITROUTER_DEFAULT_FREE_MODEL,
  BITROUTER_NITRO_TEXT_MODEL,
  CEREBRAS_NATIVE_TEXT_MODELS,
  getGroqApiModelId,
  isGroqNativeModel,
  isVastNativeModel,
} from "../models";
import type { SharedModelCallSelection } from "../services/shared-runtime/shared-runtime-timing";
import type { PooledDirectProvider } from "../services/team-credential-pool/provider-map";
import { logger } from "../utils/logger";
import { RETRYABLE_UPSTREAM_STATUSES } from "./failover";
import { toBitRouterModelId } from "./model-id-translation";
import { getProviderKey } from "./provider-env";
import { hasAnyVastProviderConfigured, resolveVastEndpointConfig } from "./vast-endpoints";

/**
 * A model-resolution failure caused by this deployment's provider
 * configuration (missing/placeholder provider key, unconfigured endpoint) —
 * as opposed to a bad request or a transient upstream failure. The message
 * intentionally names the missing env var for operators; API boundaries must
 * classify with isProviderConfigurationError and return a clean client error.
 */
export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

/**
 * True when model resolution failed because this deployment has no configured
 * provider. Unwraps the AI SDK's RetryError to the last real error.
 */
export function isProviderConfigurationError(error: unknown): boolean {
  const unwrapped = RetryError.isInstance(error) ? error.lastError : error;
  return unwrapped instanceof ProviderConfigurationError;
}

/**
 * Model id served by the self-hosted TEI embeddings sidecar
 * (packages/cloud/services/embeddings — BAAI/bge-small-en-v1.5, 384 dims).
 * When LOCAL_EMBEDDINGS_BASE_URL is set the sidecar serves this id over its
 * OpenAI-compatible /v1/embeddings surface; ELIZA_EMBEDDINGS_FORCE_LOCAL="true"
 * additionally aliases EVERY embedding id onto it. The upstream request always
 * carries this id — the sidecar embeds with its one loaded model regardless of
 * the requested spelling.
 */
export const LOCAL_EMBEDDING_MODEL_ID = "bge-small-en-v1.5";

let groqClient: ReturnType<typeof createOpenAI> | null = null;
let vastClients = new Map<string, ReturnType<typeof createOpenAI>>();
let openAIClient: {
  apiKey: string;
  baseURL?: string;
  client: ReturnType<typeof createOpenAI>;
} | null = null;
let localEmbeddingsClient: {
  apiKey: string;
  baseURL: string;
  client: ReturnType<typeof createOpenAI>;
} | null = null;
let cerebrasClient: ReturnType<typeof createOpenAI> | null = null;
let openRouterClient: ReturnType<typeof createOpenAI> | null = null;
let anthropicClient: ReturnType<typeof createAnthropic> | null = null;
const CEREBRAS_NATIVE_TEXT_MODEL_SET = new Set<string>(CEREBRAS_NATIVE_TEXT_MODELS);

function getGroqClient() {
  if (!groqClient) {
    const apiKey = getProviderKey("GROQ_API_KEY");
    if (!apiKey) {
      throw new ProviderConfigurationError("GROQ_API_KEY environment variable is required");
    }

    groqClient = createOpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }

  return groqClient;
}

function getVastClient(model: string) {
  const config = resolveVastEndpointConfig(model);
  if (!config) {
    throw new ProviderConfigurationError(`Vast endpoint is not configured for ${model}`);
  }

  const cacheKey = `${config.apiKey}|${config.baseUrl}`;
  const cached = vastClients.get(cacheKey);
  if (cached) return { client: cached, apiModelId: config.apiModelId };

  const client = createOpenAI({
    apiKey: config.apiKey,
    baseURL: `${config.baseUrl}/v1`,
  });
  vastClients.set(cacheKey, client);
  return { client, apiModelId: config.apiModelId };
}

function getOpenAIClient() {
  const apiKey = getProviderKey("OPENAI_API_KEY");
  if (!apiKey) {
    throw new ProviderConfigurationError("OPENAI_API_KEY environment variable is required");
  }

  const baseURL = getProviderKey("OPENAI_BASE_URL") ?? undefined;
  if (!openAIClient || openAIClient.apiKey !== apiKey || openAIClient.baseURL !== baseURL) {
    openAIClient = {
      apiKey,
      baseURL,
      client: createOpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      }),
    };
  }

  return openAIClient.client;
}

function getLocalEmbeddingsBaseURL(): string | null {
  const raw = getProviderKey("LOCAL_EMBEDDINGS_BASE_URL");
  if (!raw) return null;
  const baseUrl = raw.replace(/\/+$/, "");
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function isLocalEmbeddingsForced(): boolean {
  return getProviderKey("ELIZA_EMBEDDINGS_FORCE_LOCAL") === "true";
}

/** True when the local sidecar serves this embedding id (mirrors getTextEmbeddingModel). */
function isLocalEmbeddingRoutingActive(model: string): boolean {
  if (!getLocalEmbeddingsBaseURL()) return false;
  return isLocalEmbeddingsForced() || model === LOCAL_EMBEDDING_MODEL_ID;
}

function getLocalEmbeddingsClient(baseURL: string) {
  // TEI serves unauthenticated unless the sidecar sets API_KEY; the SDK client
  // requires a bearer value, so an unauthenticated deployment sends a dummy.
  const apiKey = getProviderKey("LOCAL_EMBEDDINGS_API_KEY") ?? "local";
  if (
    !localEmbeddingsClient ||
    localEmbeddingsClient.apiKey !== apiKey ||
    localEmbeddingsClient.baseURL !== baseURL
  ) {
    localEmbeddingsClient = {
      apiKey,
      baseURL,
      client: createOpenAI({ apiKey, baseURL }),
    };
  }

  return localEmbeddingsClient.client;
}

function getCerebrasClient() {
  if (!cerebrasClient) {
    const apiKey = getProviderKey("CEREBRAS_API_KEY");
    if (!apiKey) {
      throw new ProviderConfigurationError("CEREBRAS_API_KEY environment variable is required");
    }

    cerebrasClient = createOpenAI({
      apiKey,
      baseURL: "https://api.cerebras.ai/v1",
    });
  }

  return cerebrasClient;
}

function getOpenRouterApiKey(): string | null {
  return getProviderKey("OPENROUTER_API_KEY");
}

function getOpenRouterBaseURL(): string {
  const baseUrl = (getProviderKey("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    "",
  );
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function getOpenRouterClient() {
  if (!openRouterClient) {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      throw new ProviderConfigurationError("OPENROUTER_API_KEY environment variable is required");
    }

    openRouterClient = createOpenAI({
      apiKey,
      baseURL: getOpenRouterBaseURL(),
      headers: {
        "HTTP-Referer": "https://eliza.cloud",
        "X-Title": "Eliza Cloud",
      },
    });
  }

  return openRouterClient;
}

/**
 * OpenRouter shares BitRouter's catalog id format (`x-ai/…`, `anthropic/…`) and
 * `:nitro` / `:floor` routing-suffix convention, so the same translation
 * applies. Used both as the BYOK fallback behind BitRouter and as the catch-all
 * router when BitRouter is not configured.
 */
function getOpenRouterLanguageModel(model: string) {
  return getOpenRouterClient().chat(toBitRouterModelId(model));
}

const CEREBRAS_OPENROUTER_FALLBACK_MODELS: Readonly<Record<string, string>> = {
  "gemma-4-31b": "google/gemma-4-31b-it",
  "gpt-oss-120b": "openai/gpt-oss-120b",
  "zai-glm-4.7": "z-ai/glm-4.7",
};

/** Translate Cerebras-native ids into the equivalent OpenRouter catalog ids. */
function resolveCerebrasOpenRouterFallbackModel(model: string): string {
  const cerebrasModel = normalizeCerebrasModelId(model);
  const fallbackModel = CEREBRAS_OPENROUTER_FALLBACK_MODELS[cerebrasModel];
  if (!fallbackModel) {
    throw new ProviderConfigurationError(
      `No OpenRouter fallback is configured for Cerebras model ${cerebrasModel}`,
    );
  }
  return fallbackModel;
}

function getAnthropicClient() {
  if (!anthropicClient) {
    const apiKey = getProviderKey("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new ProviderConfigurationError("ANTHROPIC_API_KEY environment variable is required");
    }

    anthropicClient = createAnthropic({ apiKey });
  }

  return anthropicClient;
}

export interface PooledLanguageModelCredential {
  providerId: PooledDirectProvider;
  apiKey: string;
}

export function resolvePooledDirectProviderForModel(model: string): PooledDirectProvider | null {
  if (isCerebrasNativeModel(model)) return "cerebras-api";
  if (isOpenAINativeModel(model) && !requiresGatewayRouting(model)) return "openai-api";
  if (isAnthropicNativeModel(model)) return "anthropic-api";
  return null;
}

function getPooledLanguageModel(model: string, credential: PooledLanguageModelCredential) {
  const providerId = resolvePooledDirectProviderForModel(model);
  if (!providerId || providerId !== credential.providerId) return null;

  if (providerId === "cerebras-api") {
    return withRateLimitFailFast(
      createOpenAI({
        apiKey: credential.apiKey,
        baseURL: "https://api.cerebras.ai/v1",
      }).chat(normalizeCerebrasModelId(model)),
    );
  }

  if (providerId === "openai-api") {
    const baseURL = getProviderKey("OPENAI_BASE_URL") ?? undefined;
    const client = createOpenAI({
      apiKey: credential.apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
    const modelId = normalizeOpenAIModelId(model);
    return baseURL ? client.chat(modelId) : client.languageModel(modelId);
  }

  if (providerId === "anthropic-api") {
    return createAnthropic({ apiKey: credential.apiKey }).languageModel(
      normalizeAnthropicModelId(model),
    );
  }

  return null;
}

function isOpenAINativeModel(model: string): boolean {
  return (
    model.startsWith("openai/") ||
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("text-embedding-")
  );
}

function isAnthropicNativeModel(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("claude-");
}

function normalizeCerebrasModelId(model: string): string {
  // Strip provider/gateway namespace prefixes AND the OpenRouter routing-variant
  // suffix (:nitro / :floor / :free / …). A dedicated agent's bundled plugin
  // emits ids like "openai/gpt-oss-120b:nitro" / "openai/zai-glm-4.7:nitro" for
  // what are really bare Cerebras models. Without
  // this, isCerebrasNativeModel() misses them, so they skip cerebras-direct and
  // fall through to BitRouter → the PUBLIC api.bitrouter.ai → OpenRouter, which
  // 429s the :nitro variant (3 retries → 26-55s chats) or 500s "pricing
  // unavailable" for the large model. Recognizing the underlying Cerebras id here
  // routes them to cerebras-direct (the configured Cerebras key).
  let id = model;
  if (id.startsWith("cerebras/")) id = id.slice("cerebras/".length);
  else if (id.startsWith("cerebras:")) id = id.slice("cerebras:".length);
  else if (id.startsWith("openai/")) id = id.slice("openai/".length);
  // Collapse paid throughput variants (:nitro / :floor / …) to the bare Cerebras
  // id for cerebras-direct, but PRESERVE :free so the free tier keeps its free
  // upstream (BitRouter/OpenRouter) instead of billing the paid Cerebras key.
  const variantAt = id.indexOf(":");
  if (variantAt > 0 && id.slice(variantAt + 1) !== "free") id = id.slice(0, variantAt);
  return id;
}

function isCerebrasNativeModel(model: string): boolean {
  const modelId = normalizeCerebrasModelId(model);
  return CEREBRAS_NATIVE_TEXT_MODEL_SET.has(modelId);
}

/**
 * A direct OpenAI-compatible upstream the pass-through streaming fast path
 * (#15428) can pipe bytes from without any AI-SDK decode/re-encode. Cerebras
 * only for now: it is the measured hot path, its chat surface is plain
 * OpenAI-compat, and its `getLanguageModel` branch carries no behavior the
 * pipe would lose (no OpenRouter on-error fallback — cerebras errors surface
 * by design — and `withRateLimitFailFast` only removes retries the pipe never
 * performs). OpenAI/Anthropic/OpenRouter are deliberately excluded: their
 * branches add fallback middleware or non-OpenAI wire shapes that a byte pipe
 * would silently drop.
 */
export interface PassthroughUpstream {
  providerId: "cerebras-api";
  /** Full chat-completions endpoint URL. */
  url: string;
  apiKey: string;
  /** Model id to send upstream (normalized the same way getLanguageModel does). */
  modelId: string;
}

/**
 * Resolve the direct upstream for a pass-through streamed request, mirroring
 * getLanguageModel's routing precedence (the cerebras-direct branch is checked
 * before gateway routing). Null when the model is not cerebras-native or no
 * platform key is configured — callers must fall through to the SDK path.
 */
export function resolvePassthroughUpstreamForModel(model: string): PassthroughUpstream | null {
  if (!isCerebrasNativeModel(model)) return null;
  const apiKey = getProviderKey("CEREBRAS_API_KEY");
  if (!apiKey) return null;
  return {
    providerId: "cerebras-api",
    url: "https://api.cerebras.ai/v1/chat/completions",
    apiKey,
    modelId: normalizeCerebrasModelId(model),
  };
}

export interface PassthroughEmbeddingsUpstream {
  providerId: "openai-api";
  /** Full embeddings endpoint URL. */
  url: string;
  apiKey: string;
  /** Model id to send upstream (normalized the same way getTextEmbeddingModel does). */
  modelId: string;
}

/**
 * Resolve the direct upstream for a pass-through embeddings request, mirroring
 * getTextEmbeddingModel's routing precedence (OpenAI direct only — the Vercel
 * AI Gateway fallback keeps the SDK path since its wire shape is not
 * guaranteed OpenAI-verbatim). Null when no OpenAI key is configured, or when
 * the self-hosted embeddings sidecar claims the model — callers must fall
 * through to the SDK path.
 */
export function resolvePassthroughEmbeddingsUpstream(
  model: string,
): PassthroughEmbeddingsUpstream | null {
  // The self-hosted sidecar claims the local id (and everything under
  // force-local); OpenAI must never receive those requests, so the pass-through
  // fast path stands down and the SDK path routes (or config-errors) instead.
  if (model === LOCAL_EMBEDDING_MODEL_ID || isLocalEmbeddingRoutingActive(model)) {
    return null;
  }
  const apiKey = getProviderKey("OPENAI_API_KEY");
  if (!apiKey) return null;
  const baseURL = (getProviderKey("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  return {
    providerId: "openai-api",
    url: `${baseURL}/embeddings`,
    apiKey,
    modelId: normalizeOpenAIModelId(model),
  };
}

/**
 * Canonicalize a requested model id for pricing AND routing. Dedicated agents
 * emit decorated ids like "openai/gpt-oss-120b:nitro" / "openai/zai-glm-4.7:nitro"
 * for what are really the bare Cerebras models. Collapse those to the bare
 * Cerebras id at the route entry so the pricing lookup (which only carries the
 * Cerebras row — "openai/zai-glm-4.7" is not an OpenRouter model → 500 "pricing
 * unavailable") and the provider routing (cerebras-direct) agree. Non-Cerebras
 * ids are returned unchanged so their normal BitRouter/gateway routing + pricing
 * is untouched.
 */
export function canonicalizeCerebrasModelId(model: string): string {
  return isCerebrasNativeModel(model) ? normalizeCerebrasModelId(model) : model;
}

/** HTTP status of an AI-SDK provider error, unwrapping the retry envelope. */
function aiSdkErrorStatus(error: unknown): number | null {
  const unwrapped = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(unwrapped) && typeof unwrapped.statusCode === "number") {
    return unwrapped.statusCode;
  }
  return null;
}

function isRetryableAiSdkError(error: unknown): boolean {
  const status = aiSdkErrorStatus(error);
  return status !== null && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function aiSdkErrorSearchText(error: unknown): string {
  const unwrapped = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(unwrapped)) {
    return error instanceof Error ? error.message : String(error);
  }
  return [
    unwrapped.message,
    unwrapped.responseBody,
    unwrapped.data === undefined ? undefined : JSON.stringify(unwrapped.data),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/** OpenRouter occasionally rejects a valid serialized model with this exact routing error. */
function isTransientOpenRouterNoModelsError(error: unknown): boolean {
  return (
    aiSdkErrorStatus(error) === 400 && /\bno models provided\b/i.test(aiSdkErrorSearchText(error))
  );
}

async function invokeOpenRouterFallback<T>(
  model: string,
  operation: "generate" | "stream",
  invoke: () => PromiseLike<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    // error-policy:J1 OpenRouter's exact transient routing rejection is
    // translated at the provider boundary into one immediate identical retry.
    if (!isTransientOpenRouterNoModelsError(error)) throw error;
    logger.warn(
      "[OpenRouter] Transient no-models %s rejection for %s; retrying once (no backoff)",
      operation,
      model,
    );
    return await invoke();
  }
}

/**
 * Wraps a native primary language model so that, on a retryable upstream error
 * (402/429/5xx), the request fails over to OpenRouter (BYOK) for the same model.
 * This is the "OpenRouter is the backup" path: the Worker calls the native
 * provider directly (no hop) on the happy path; OpenRouter is only reached when
 * the native call returns a retryable error. A no-op when OPENROUTER_API_KEY is
 * unset, so direct-only deployments are unchanged.
 */
/**
 * `nativeProvider` names the provider serving `primaryModel` so a successful
 * native call is attributed to itself rather than to the catch-all `other`.
 */
function withOpenRouterFallback(
  primaryModel: Parameters<typeof wrapLanguageModel>[0]["model"],
  model: string,
  nativeProvider: InteractiveLanguageModelSelection["provider"],
  onProviderSelected?: (selection: InteractiveLanguageModelSelection) => void,
) {
  if (!getOpenRouterApiKey()) {
    return withSuccessfulProviderSelection(
      primaryModel,
      { provider: nativeProvider, fallback: false },
      onProviderSelected,
    );
  }

  const fallbackModel = getOpenRouterLanguageModel(model);
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        const result = await doGenerate();
        notifyProviderSelected(onProviderSelected, { provider: nativeProvider, fallback: false });
        return result;
      } catch (error) {
        if (!isRetryableAiSdkError(error)) {
          throw error;
        }
        logger.warn(
          "[OpenRouter] Primary router failed for %s (%d); falling back to OpenRouter",
          model,
          aiSdkErrorStatus(error),
        );
        const result = await invokeOpenRouterFallback(model, "generate", () =>
          fallbackModel.doGenerate(params),
        );
        notifyProviderSelected(onProviderSelected, { provider: "openrouter", fallback: true });
        return result;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        const result = await doStream();
        notifyProviderSelected(onProviderSelected, { provider: nativeProvider, fallback: false });
        return result;
      } catch (error) {
        if (!isRetryableAiSdkError(error)) {
          throw error;
        }
        logger.warn(
          "[OpenRouter] Primary router stream failed for %s (%d); falling back to OpenRouter",
          model,
          aiSdkErrorStatus(error),
        );
        const result = await invokeOpenRouterFallback(model, "stream", () =>
          fallbackModel.doStream(params),
        );
        notifyProviderSelected(onProviderSelected, { provider: "openrouter", fallback: true });
        return result;
      }
    },
  };

  return wrapLanguageModel({ model: primaryModel, middleware });
}

function withSuccessfulProviderSelection(
  model: Parameters<typeof wrapLanguageModel>[0]["model"],
  selection: InteractiveLanguageModelSelection,
  onProviderSelected?: (selection: InteractiveLanguageModelSelection) => void,
) {
  if (!onProviderSelected) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        notifyProviderSelected(onProviderSelected, selection);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        notifyProviderSelected(onProviderSelected, selection);
        return result;
      },
    },
  });
}

/**
 * Wraps the cerebras chat model so a 429 (rate-limited) surfaces FAST instead of
 * after the AI SDK's default 3-attempt exponential backoff (~50s). The SDK retries
 * a 429 because the provider marks the `APICallError` `isRetryable: true`; we
 * re-throw just the 429 as a NON-retryable `APICallError` so the retry loop gives
 * up on the first attempt and the chat path's graceful "model provider
 * rate-limited" reply surfaces in a few seconds rather than stalling the turn.
 * Only 429 is short-circuited — 5xx/network keep the SDK's normal retry/backoff,
 * and the 429 keeps its status so downstream classification still maps it to a
 * rate-limit reply. Cerebras-only (the chat reply path); embeddings and
 * structured output are untouched.
 */
function withRateLimitFailFast(primaryModel: Parameters<typeof wrapLanguageModel>[0]["model"]) {
  const failFast = (error: unknown): never => {
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new APICallError({
        message: error.message,
        url: error.url,
        requestBodyValues: error.requestBodyValues,
        statusCode: 429,
        responseHeaders: error.responseHeaders,
        responseBody: error.responseBody,
        cause: error.cause,
        isRetryable: false,
        data: error.data,
      });
    }
    throw error;
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      try {
        return await doGenerate();
      } catch (error) {
        return failFast(error);
      }
    },
    wrapStream: async ({ doStream }) => {
      try {
        return await doStream();
      } catch (error) {
        return failFast(error);
      }
    },
  };
  return wrapLanguageModel({ model: primaryModel, middleware });
}

/**
 * Cerebras interactive-turn 5xx/network fast-failover to OpenRouter — the
 * COLD-PATH stall-B fix (COLDPATH-FIX-2026-07-21).
 *
 * The problem this removes: Cerebras is the shared/interactive default and had
 * NO cross-provider fallback (`withRateLimitFailFast` only short-circuits 429).
 * On a transient Cerebras 5xx/network blip the AI SDK's own retry loop SLEEPS
 * `initialDelayInMs=2000` (then 4s) before retrying the SAME dead provider, so
 * a single blip cost +2s and two cost +6s of pure backoff BEFORE first token —
 * the exact bimodal warm-stall on staging. #16713 only *bounded* that sleep by
 * capping retries; it did not remove it, and it still retried the same upstream.
 *
 * This wrapper instead fails over IMMEDIATELY (no sleep) to OpenRouter for the
 * SAME model on a retryable upstream error (402/429/5xx). Composed OUTSIDE
 * `withRateLimitFailFast`, so a 429 arrives here already marked non-retryable
 * by the inner wrap AND is served by the healthy fallback rather than surfaced
 * as a stall — the interactive turn's job is to answer, not to sleep. Callers
 * that must surface Cerebras errors verbatim (the graceful rate-limit reply on
 * non-interactive paths) keep using the bare `withRateLimitFailFast` model via
 * `getLanguageModel`'s default branch; this failover is opt-in through
 * `getInteractiveCerebrasLanguageModel`. A no-op when OPENROUTER_API_KEY is
 * unset, so direct-only deployments are unchanged (they keep the bounded-retry
 * behavior, now paired with `maxRetries: 0` on the interactive turn).
 */
function withCerebrasInteractiveFailover(
  primaryModel: Parameters<typeof wrapLanguageModel>[0]["model"],
  model: string,
  onProviderSelected?: (selection: InteractiveLanguageModelSelection) => void,
) {
  if (!getOpenRouterApiKey()) {
    return withSuccessfulProviderSelection(
      primaryModel,
      { provider: "cerebras", fallback: false },
      onProviderSelected,
    );
  }
  const fallbackModel = getOpenRouterLanguageModel(resolveCerebrasOpenRouterFallbackModel(model));
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        const result = await doGenerate();
        notifyProviderSelected(onProviderSelected, { provider: "cerebras", fallback: false });
        return result;
      } catch (error) {
        if (!isRetryableAiSdkError(error)) throw error;
        logger.warn(
          "[Cerebras] Interactive turn failed for %s (%d); failing over to OpenRouter (no backoff)",
          model,
          aiSdkErrorStatus(error),
        );
        const result = await invokeOpenRouterFallback(model, "generate", () =>
          fallbackModel.doGenerate(params),
        );
        notifyProviderSelected(onProviderSelected, { provider: "openrouter", fallback: true });
        return result;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        const result = await doStream();
        notifyProviderSelected(onProviderSelected, { provider: "cerebras", fallback: false });
        return result;
      } catch (error) {
        if (!isRetryableAiSdkError(error)) throw error;
        logger.warn(
          "[Cerebras] Interactive stream failed for %s (%d); failing over to OpenRouter (no backoff)",
          model,
          aiSdkErrorStatus(error),
        );
        const result = await invokeOpenRouterFallback(model, "stream", () =>
          fallbackModel.doStream(params),
        );
        notifyProviderSelected(onProviderSelected, { provider: "openrouter", fallback: true });
        return result;
      }
    },
  };
  return wrapLanguageModel({ model: primaryModel, middleware });
}

/**
 * Provider attribution reported to a timing observer once a call succeeds.
 * `other` is the deliberate catch-all for pooled, Groq, and Vast models, whose
 * individual identity the Shared timing receipt does not need.
 */
export interface InteractiveLanguageModelSelection {
  provider: SharedModelCallSelection["provider"];
  fallback: boolean;
}

function notifyProviderSelected(
  observer: ((selection: InteractiveLanguageModelSelection) => void) | undefined,
  selection: InteractiveLanguageModelSelection,
): void {
  if (!observer) return;
  try {
    observer(selection);
  } catch (error) {
    // error-policy:J7 timing must never change a successful inference outcome.
    logger.warn("[language-model] Provider-selection observer failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resolve the interactive-turn language model for a bare Cerebras id: the same
 * cerebras-direct client the default branch uses, but wrapped so a transient
 * 5xx/network fails over to OpenRouter WITHOUT the AI SDK's 2s/6s backoff sleep
 * (see withCerebrasInteractiveFailover). Non-Cerebras ids fall through to the
 * normal router. Interactive callers (shared-runtime chat/voice turn) pair this
 * with `maxRetries: 0` so the only retry is the instant cross-provider failover.
 */
export function getInteractiveCerebrasLanguageModel(
  model: string,
  onProviderSelected?: (selection: InteractiveLanguageModelSelection) => void,
) {
  if (isCerebrasNativeModel(model) && getProviderKey("CEREBRAS_API_KEY")) {
    return withCerebrasInteractiveFailover(
      withRateLimitFailFast(getCerebrasClient().chat(normalizeCerebrasModelId(model))),
      model,
      onProviderSelected,
    );
  }
  return getLanguageModel(model, undefined, onProviderSelected);
}

/**
 * True for OpenRouter-catalog ids that NO native provider can serve directly —
 * routing-suffix variants (`:nitro`/`:floor`), the free tier, and `openai/gpt-oss-120b`
 * (an OpenRouter id, not an OpenAI-API model). These must go to the OpenRouter
 * backup even though they carry an `openai/` prefix.
 */
function requiresGatewayRouting(model: string): boolean {
  const catalogModel = toBitRouterModelId(model);
  return (
    catalogModel === BITROUTER_NITRO_TEXT_MODEL ||
    catalogModel === BITROUTER_DEFAULT_FREE_MODEL ||
    catalogModel === "openai/gpt-oss-120b" ||
    (catalogModel.includes("/") && catalogModel.split("/")[1]?.includes(":"))
  );
}

function normalizeOpenAIModelId(model: string): string {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

function normalizeAnthropicModelId(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

/**
 * True iff the OpenRouter backup provider is configured.
 */
export function hasGatewayProviderConfigured(): boolean {
  return getOpenRouterApiKey() !== null;
}

export function hasLanguageModelProviderConfigured(model: string): boolean {
  if (isGroqNativeModel(model)) {
    return Boolean(getProviderKey("GROQ_API_KEY"));
  }

  if (isVastNativeModel(model)) {
    return resolveVastEndpointConfig(model) !== null;
  }

  if (isCerebrasNativeModel(model) && getProviderKey("CEREBRAS_API_KEY")) {
    return true;
  }

  // OpenRouter-catalog ids no native provider can serve → need the backup.
  if (requiresGatewayRouting(model)) {
    return Boolean(getOpenRouterApiKey());
  }

  if (isOpenAINativeModel(model)) {
    return Boolean(getProviderKey("OPENAI_API_KEY")) || Boolean(getOpenRouterApiKey());
  }

  if (isAnthropicNativeModel(model)) {
    return Boolean(getProviderKey("ANTHROPIC_API_KEY")) || Boolean(getOpenRouterApiKey());
  }

  // Anything else is served by the OpenRouter backup.
  return Boolean(getOpenRouterApiKey());
}

export function hasTextEmbeddingProviderConfigured(model?: string): boolean {
  // Mirror getTextEmbeddingModel: the self-hosted sidecar serves the local id
  // (or every id under force-local); the local id has no other upstream. The
  // model is optional because some callers gate before parsing a request body —
  // an argless call only credits the sidecar for the force-local deployment.
  if (
    getLocalEmbeddingsBaseURL() &&
    (isLocalEmbeddingsForced() || model === LOCAL_EMBEDDING_MODEL_ID)
  ) {
    return true;
  }
  if (model === LOCAL_EMBEDDING_MODEL_ID) return false;
  return Boolean(getProviderKey("OPENAI_API_KEY"));
}

export function getLanguageModel(
  model: string,
  credential?: PooledLanguageModelCredential,
  onProviderSelected?: (selection: InteractiveLanguageModelSelection) => void,
) {
  if (credential) {
    const pooledModel = getPooledLanguageModel(model, credential);
    if (pooledModel) {
      return withSuccessfulProviderSelection(
        pooledModel,
        { provider: "other", fallback: false },
        onProviderSelected,
      );
    }
  }

  if (isGroqNativeModel(model)) {
    return withSuccessfulProviderSelection(
      getGroqClient().languageModel(getGroqApiModelId(model)),
      { provider: "other", fallback: false },
      onProviderSelected,
    );
  }

  if (isVastNativeModel(model)) {
    const { client, apiModelId } = getVastClient(model);
    return withSuccessfulProviderSelection(
      client.languageModel(apiModelId),
      { provider: "other", fallback: false },
      onProviderSelected,
    );
  }

  // Cerebras-native bare IDs (gemma-4-31b, gpt-oss-120b, zai-glm-4.7) → Cerebras direct.
  // Cerebras-only by design: a 429 must surface so the chat path can return the
  // graceful "model provider rate-limited" reply rather than silently failing
  // over to OpenRouter on a different provider. Wrapped in withRateLimitFailFast
  // so that 429 surfaces in ~one round-trip instead of after the AI SDK's default
  // ~50s 3-attempt backoff (which turned a throttled turn into a 50s hang).
  if (isCerebrasNativeModel(model) && getProviderKey("CEREBRAS_API_KEY")) {
    return withSuccessfulProviderSelection(
      withRateLimitFailFast(getCerebrasClient().chat(normalizeCerebrasModelId(model))),
      { provider: "cerebras", fallback: false },
      onProviderSelected,
    );
  }

  // OpenRouter-catalog ids no native provider can serve (`:nitro`/`:floor`,
  // `openai/gpt-oss-120b` as an OpenRouter id) → OpenRouter backup.
  if (requiresGatewayRouting(model)) {
    if (getOpenRouterApiKey()) {
      return withSuccessfulProviderSelection(
        getOpenRouterLanguageModel(model),
        { provider: "openrouter", fallback: false },
        onProviderSelected,
      );
    }
    throw new ProviderConfigurationError("OPENROUTER_API_KEY is required for this model");
  }

  // Native, DIRECT providers (no hop) when we hold the key, with OpenRouter as
  // an on-error backup for the same model.
  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    const modelId = normalizeOpenAIModelId(model);
    const primary = getProviderKey("OPENAI_BASE_URL")
      ? getOpenAIClient().chat(modelId)
      : getOpenAIClient().languageModel(modelId);
    return withOpenRouterFallback(primary, model, "openai", onProviderSelected);
  }

  if (isAnthropicNativeModel(model) && getProviderKey("ANTHROPIC_API_KEY")) {
    return withOpenRouterFallback(
      getAnthropicClient().languageModel(normalizeAnthropicModelId(model)),
      model,
      "anthropic",
      onProviderSelected,
    );
  }

  // Backup: OpenRouter (BYOK) serves any model we have no native key for.
  if (getOpenRouterApiKey()) {
    return withSuccessfulProviderSelection(
      getOpenRouterLanguageModel(model),
      { provider: "openrouter", fallback: false },
      onProviderSelected,
    );
  }

  throw new ProviderConfigurationError(
    "AI language model provider is not configured (set a native provider key or OPENROUTER_API_KEY)",
  );
}

export function getTextEmbeddingModel(model: string) {
  // Self-hosted TEI sidecar (packages/cloud/services/embeddings): serves the
  // 384-dim local id, or EVERY id when ELIZA_EMBEDDINGS_FORCE_LOCAL aliases the
  // deployment onto it. The upstream request always carries the local id — the
  // sidecar embeds with its one loaded model regardless of requested spelling.
  const localBaseURL = getLocalEmbeddingsBaseURL();
  if (localBaseURL && (isLocalEmbeddingsForced() || model === LOCAL_EMBEDDING_MODEL_ID)) {
    return getLocalEmbeddingsClient(localBaseURL).textEmbeddingModel(LOCAL_EMBEDDING_MODEL_ID);
  }

  // Only the sidecar can serve the local id — OpenAI would 404 it, so a
  // deployment without the sidecar URL is a configuration error, not a
  // fallthrough to a provider that cannot answer.
  if (model === LOCAL_EMBEDDING_MODEL_ID) {
    throw new ProviderConfigurationError(
      `LOCAL_EMBEDDINGS_BASE_URL environment variable is required for ${LOCAL_EMBEDDING_MODEL_ID}`,
    );
  }

  // Embeddings are OpenAI-native (`text-embedding-*`). OpenRouter has no
  // `/v1/embeddings` route, so it is not an embedding backup.
  if (getProviderKey("OPENAI_API_KEY")) {
    return getOpenAIClient().textEmbeddingModel(normalizeOpenAIModelId(model));
  }

  throw new ProviderConfigurationError("AI text embedding provider is not configured");
}

export function getAiProviderConfigurationError(): string {
  return "AI services are not configured on this deployment";
}

export function hasOpenAIProviderConfigured(): boolean {
  return Boolean(getProviderKey("OPENAI_API_KEY"));
}

export function hasAnthropicProviderConfigured(): boolean {
  return Boolean(getProviderKey("ANTHROPIC_API_KEY"));
}

export function hasGroqLanguageModelProviderConfigured(): boolean {
  return Boolean(getProviderKey("GROQ_API_KEY"));
}

export function resolveAiProviderSource(
  model: string,
): "groq" | "vast" | "bitrouter" | "cerebras" | "openai" | "anthropic" | null {
  if (isGroqNativeModel(model)) {
    return getProviderKey("GROQ_API_KEY") ? "groq" : null;
  }

  if (isVastNativeModel(model)) {
    return resolveVastEndpointConfig(model) ? "vast" : null;
  }

  // Mirror getLanguageModel: native providers serve their own models directly.
  if (isCerebrasNativeModel(model) && getProviderKey("CEREBRAS_API_KEY")) {
    return "cerebras";
  }

  // OpenRouter-catalog ids served by the backup. OpenRouter prices are catalogued
  // under billingSource "bitrouter" (the shared catalog key — see
  // ai-pricing/providers/openrouter.ts), so attribute them to "bitrouter".
  if (requiresGatewayRouting(model)) {
    if (getOpenRouterApiKey()) {
      return "bitrouter";
    }
    return null;
  }

  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    return "openai";
  }

  if (isAnthropicNativeModel(model) && getProviderKey("ANTHROPIC_API_KEY")) {
    return "anthropic";
  }

  // Backup: OpenRouter (BYOK), billed to the shared "bitrouter" price catalog.
  if (getOpenRouterApiKey()) {
    return "bitrouter";
  }

  return null;
}

export function resolveEmbeddingProviderSource(model?: string): "openai" | "selfhosted" | null {
  // Mirror getTextEmbeddingModel: the self-hosted sidecar wins for the local id
  // (or for everything under force-local); OpenAI direct serves the rest. The
  // model is optional because some callers gate before parsing a request body —
  // an argless call only reports "selfhosted" for the force-local deployment.
  if (
    getLocalEmbeddingsBaseURL() &&
    (isLocalEmbeddingsForced() || model === LOCAL_EMBEDDING_MODEL_ID)
  ) {
    return "selfhosted";
  }
  if (model === LOCAL_EMBEDDING_MODEL_ID) return null;
  if (getProviderKey("OPENAI_API_KEY")) {
    return "openai";
  }

  return null;
}

export function hasAnyAiProviderConfigured(): boolean {
  return Boolean(
    getOpenRouterApiKey() ||
      getProviderKey("CEREBRAS_API_KEY") ||
      getProviderKey("OPENAI_API_KEY") ||
      getProviderKey("ANTHROPIC_API_KEY") ||
      getProviderKey("GROQ_API_KEY") ||
      hasAnyVastProviderConfigured(),
  );
}

export function getAiProviderConfigurationStatus() {
  return {
    openrouter: Boolean(getOpenRouterApiKey()),
    cerebras: Boolean(getProviderKey("CEREBRAS_API_KEY")),
    openai: Boolean(getProviderKey("OPENAI_API_KEY")),
    anthropic: Boolean(getProviderKey("ANTHROPIC_API_KEY")),
    groq: Boolean(getProviderKey("GROQ_API_KEY")),
    vast: hasAnyVastProviderConfigured(),
  };
}

export function getAiProviderConfigurationSummary(): string {
  const status = getAiProviderConfigurationStatus();
  const configured = Object.entries(status)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return configured.length > 0 ? configured.join(", ") : "none";
}
