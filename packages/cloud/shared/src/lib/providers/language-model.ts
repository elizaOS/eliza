import { createAnthropic } from "@ai-sdk/anthropic";
import { createGatewayProvider, type GatewayProvider } from "@ai-sdk/gateway";
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
import type { PooledDirectProvider } from "../services/team-credential-pool/provider-map";
import { logger } from "../utils/logger";
import { RETRYABLE_UPSTREAM_STATUSES } from "./failover";
import { toBitRouterModelId } from "./model-id-translation";
import { getProviderKey } from "./provider-env";
import { hasAnyVastProviderConfigured, resolveVastEndpointConfig } from "./vast-endpoints";

let groqClient: ReturnType<typeof createOpenAI> | null = null;
let vastClients = new Map<string, ReturnType<typeof createOpenAI>>();
let openAIClient: {
  apiKey: string;
  baseURL?: string;
  client: ReturnType<typeof createOpenAI>;
} | null = null;
let cerebrasClient: ReturnType<typeof createOpenAI> | null = null;
let openRouterClient: ReturnType<typeof createOpenAI> | null = null;
let anthropicClient: ReturnType<typeof createAnthropic> | null = null;
let vercelAIGatewayClient: GatewayProvider | null = null;
const CEREBRAS_NATIVE_TEXT_MODEL_SET = new Set<string>(CEREBRAS_NATIVE_TEXT_MODELS);

function getGroqClient() {
  if (!groqClient) {
    const apiKey = getProviderKey("GROQ_API_KEY");
    if (!apiKey) {
      throw new Error("GROQ_API_KEY environment variable is required");
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
    throw new Error(`Vast endpoint is not configured for ${model}`);
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
    throw new Error("OPENAI_API_KEY environment variable is required");
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

function getCerebrasClient() {
  if (!cerebrasClient) {
    const apiKey = getProviderKey("CEREBRAS_API_KEY");
    if (!apiKey) {
      throw new Error("CEREBRAS_API_KEY environment variable is required");
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

function getVercelAIGatewayApiKey(): string | null {
  return getProviderKey("AI_GATEWAY_API_KEY") ?? getProviderKey("AIGATEWAY_API_KEY");
}

function getVercelAIGatewayBaseURL(): string | undefined {
  return getProviderKey("AI_GATEWAY_BASE_URL") ?? undefined;
}

function getOpenRouterClient() {
  if (!openRouterClient) {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY environment variable is required");
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

function getAnthropicClient() {
  if (!anthropicClient) {
    const apiKey = getProviderKey("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
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

function getVercelAIGatewayClient() {
  if (!vercelAIGatewayClient) {
    const apiKey = getVercelAIGatewayApiKey();
    if (!apiKey) {
      throw new Error("AI_GATEWAY_API_KEY environment variable is required");
    }

    vercelAIGatewayClient = createGatewayProvider({
      apiKey,
      ...(getVercelAIGatewayBaseURL() ? { baseURL: getVercelAIGatewayBaseURL() } : {}),
    });
  }

  return vercelAIGatewayClient;
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

/**
 * Wraps a native primary language model so that, on a retryable upstream error
 * (402/429/5xx), the request fails over to OpenRouter (BYOK) for the same model.
 * This is the "OpenRouter is the backup" path: the Worker calls the native
 * provider directly (no hop) on the happy path; OpenRouter is only reached when
 * the native call returns a retryable error. A no-op when OPENROUTER_API_KEY is
 * unset, so direct-only deployments are unchanged.
 */
function withOpenRouterFallback(
  primaryModel: Parameters<typeof wrapLanguageModel>[0]["model"],
  model: string,
) {
  if (!getOpenRouterApiKey()) {
    return primaryModel;
  }

  const fallbackModel = getOpenRouterLanguageModel(model);
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (!isRetryableAiSdkError(error)) {
          throw error;
        }
        logger.warn(
          "[OpenRouter] Primary router failed for %s (%d); falling back to OpenRouter",
          model,
          aiSdkErrorStatus(error),
        );
        return await fallbackModel.doGenerate(params);
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (error) {
        if (!isRetryableAiSdkError(error)) {
          throw error;
        }
        logger.warn(
          "[OpenRouter] Primary router stream failed for %s (%d); falling back to OpenRouter",
          model,
          aiSdkErrorStatus(error),
        );
        return await fallbackModel.doStream(params);
      }
    },
  };

  return wrapLanguageModel({ model: primaryModel, middleware });
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
 * True iff a gateway-style backup provider is configured: OpenRouter (BYOK) is
 * the backup for non-native models; Vercel AI Gateway is the local/dev fallback.
 */
export function hasGatewayProviderConfigured(): boolean {
  return getOpenRouterApiKey() !== null || getVercelAIGatewayApiKey() !== null;
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
    return Boolean(getOpenRouterApiKey()) || Boolean(getVercelAIGatewayApiKey());
  }

  if (isOpenAINativeModel(model)) {
    return Boolean(getProviderKey("OPENAI_API_KEY")) || Boolean(getOpenRouterApiKey());
  }

  if (isAnthropicNativeModel(model)) {
    return Boolean(getProviderKey("ANTHROPIC_API_KEY")) || Boolean(getOpenRouterApiKey());
  }

  // Anything else is served by the OpenRouter backup (or the dev gateway).
  return Boolean(getOpenRouterApiKey()) || Boolean(getVercelAIGatewayApiKey());
}

export function hasTextEmbeddingProviderConfigured(): boolean {
  return Boolean(getProviderKey("OPENAI_API_KEY") || getVercelAIGatewayApiKey());
}

export function getLanguageModel(model: string, credential?: PooledLanguageModelCredential) {
  if (credential) {
    const pooledModel = getPooledLanguageModel(model, credential);
    if (pooledModel) return pooledModel;
  }

  if (isGroqNativeModel(model)) {
    return getGroqClient().languageModel(getGroqApiModelId(model));
  }

  if (isVastNativeModel(model)) {
    const { client, apiModelId } = getVastClient(model);
    return client.languageModel(apiModelId);
  }

  // Cerebras-native bare IDs (gemma-4-31b, gpt-oss-120b, zai-glm-4.7) → Cerebras direct.
  // Cerebras-only by design: a 429 must surface so the chat path can return the
  // graceful "model provider rate-limited" reply rather than silently failing
  // over to OpenRouter on a different provider. Wrapped in withRateLimitFailFast
  // so that 429 surfaces in ~one round-trip instead of after the AI SDK's default
  // ~50s 3-attempt backoff (which turned a throttled turn into a 50s hang).
  if (isCerebrasNativeModel(model) && getProviderKey("CEREBRAS_API_KEY")) {
    return withRateLimitFailFast(getCerebrasClient().chat(normalizeCerebrasModelId(model)));
  }

  // OpenRouter-catalog ids no native provider can serve (`:nitro`/`:floor`,
  // `openai/gpt-oss-120b` as an OpenRouter id) → OpenRouter backup (or dev gateway).
  if (requiresGatewayRouting(model)) {
    if (getOpenRouterApiKey()) {
      return getOpenRouterLanguageModel(model);
    }
    if (getVercelAIGatewayApiKey()) {
      return getVercelAIGatewayClient().languageModel(model as never);
    }
    throw new Error("OPENROUTER_API_KEY is required for this model");
  }

  // Native, DIRECT providers (no hop) when we hold the key, with OpenRouter as
  // an on-error backup for the same model.
  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    const modelId = normalizeOpenAIModelId(model);
    const primary = getProviderKey("OPENAI_BASE_URL")
      ? getOpenAIClient().chat(modelId)
      : getOpenAIClient().languageModel(modelId);
    return withOpenRouterFallback(primary, model);
  }

  if (isAnthropicNativeModel(model) && getProviderKey("ANTHROPIC_API_KEY")) {
    return withOpenRouterFallback(
      getAnthropicClient().languageModel(normalizeAnthropicModelId(model)),
      model,
    );
  }

  // Dev convenience gateway.
  if (getVercelAIGatewayApiKey()) {
    return getVercelAIGatewayClient().languageModel(model as never);
  }

  // Backup: OpenRouter (BYOK) serves any model we have no native key for.
  if (getOpenRouterApiKey()) {
    return getOpenRouterLanguageModel(model);
  }

  throw new Error(
    "AI language model provider is not configured (set a native provider key or OPENROUTER_API_KEY)",
  );
}

export function getTextEmbeddingModel(model: string) {
  // Embeddings are OpenAI-native (`text-embedding-*`). Prefer a real OpenAI key
  // Embeddings are OpenAI-native (`text-embedding-*`): OpenAI direct, then the
  // dev gateway. OpenRouter has no `/v1/embeddings` route, so it is not an
  // embedding backup.
  if (getProviderKey("OPENAI_API_KEY")) {
    return getOpenAIClient().textEmbeddingModel(normalizeOpenAIModelId(model));
  }

  if (getVercelAIGatewayApiKey()) {
    return getVercelAIGatewayClient().embeddingModel(model as never);
  }

  throw new Error("AI text embedding provider is not configured");
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
): "groq" | "vast" | "bitrouter" | "gateway" | "cerebras" | "openai" | "anthropic" | null {
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
    return getVercelAIGatewayApiKey() ? "gateway" : null;
  }

  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    return "openai";
  }

  if (isAnthropicNativeModel(model) && getProviderKey("ANTHROPIC_API_KEY")) {
    return "anthropic";
  }

  if (getVercelAIGatewayApiKey()) {
    return "gateway";
  }

  // Backup: OpenRouter (BYOK), billed to the shared "bitrouter" price catalog.
  if (getOpenRouterApiKey()) {
    return "bitrouter";
  }

  return null;
}

export function resolveEmbeddingProviderSource(): "gateway" | "openai" | null {
  // Mirror getTextEmbeddingModel: OpenAI native → dev gateway.
  if (getProviderKey("OPENAI_API_KEY")) {
    return "openai";
  }

  if (getVercelAIGatewayApiKey()) {
    return "gateway";
  }

  return null;
}

export function hasAnyAiProviderConfigured(): boolean {
  return Boolean(
    getOpenRouterApiKey() ||
      getVercelAIGatewayApiKey() ||
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
    gateway: Boolean(getVercelAIGatewayApiKey()),
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
