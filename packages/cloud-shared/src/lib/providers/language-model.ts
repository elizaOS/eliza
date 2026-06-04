import { createAnthropic } from "@ai-sdk/anthropic";
import { createGatewayProvider, type GatewayProvider } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import {
  CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
  CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
  getGroqApiModelId,
  isGroqNativeModel,
  isVastNativeModel,
  OPENROUTER_DEFAULT_FREE_MODEL,
  OPENROUTER_RECOMMENDED_TEXT_MODEL,
} from "../models";
import { toOpenRouterModelId } from "./model-id-translation";
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
let bitRouterClient: ReturnType<typeof createOpenAI> | null = null;
let anthropicClient: ReturnType<typeof createAnthropic> | null = null;
let vercelAIGatewayClient: GatewayProvider | null = null;

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

function getBitRouterApiKey(): string | null {
  return getProviderKey("BITROUTER_API_KEY");
}

function getBitRouterBaseURL(): string {
  const baseUrl = (getProviderKey("BITROUTER_BASE_URL") ?? "https://api.bitrouter.ai/v1").replace(
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

function getBitRouterClient() {
  if (!bitRouterClient) {
    const apiKey = getBitRouterApiKey();
    if (!apiKey) {
      throw new Error("BITROUTER_API_KEY environment variable is required");
    }

    bitRouterClient = createOpenAI({
      apiKey,
      baseURL: getBitRouterBaseURL(),
    });
  }

  return bitRouterClient;
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
  return model.startsWith("cerebras/") ? model.slice("cerebras/".length) : model;
}

function isCerebrasNativeModel(model: string): boolean {
  const modelId = normalizeCerebrasModelId(model);
  return (
    modelId === CEREBRAS_DEFAULT_TEXT_SMALL_MODEL || modelId === CEREBRAS_DEFAULT_TEXT_LARGE_MODEL
  );
}

function requiresOpenRouterRouting(model: string): boolean {
  const openRouterModel = toOpenRouterModelId(model);
  return (
    openRouterModel === OPENROUTER_RECOMMENDED_TEXT_MODEL ||
    openRouterModel === OPENROUTER_DEFAULT_FREE_MODEL ||
    openRouterModel === "openai/gpt-oss-120b" ||
    (openRouterModel.includes("/") && openRouterModel.split("/")[1]?.includes(":"))
  );
}

function normalizeOpenAIModelId(model: string): string {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

function normalizeAnthropicModelId(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

/**
 * True iff a gateway-style provider is configured. BitRouter stays first
 * when present; Vercel AI Gateway is the local/dev fallback.
 */
export function hasGatewayProviderConfigured(): boolean {
  return getBitRouterApiKey() !== null || getVercelAIGatewayApiKey() !== null;
}

export function hasLanguageModelProviderConfigured(model: string): boolean {
  if (isGroqNativeModel(model)) {
    return Boolean(getProviderKey("GROQ_API_KEY"));
  }

  if (isVastNativeModel(model)) {
    return resolveVastEndpointConfig(model) !== null;
  }

  if (getBitRouterApiKey()) {
    return true;
  }

  if (requiresOpenRouterRouting(model)) {
    return false;
  }

  if (isCerebrasNativeModel(model)) {
    return Boolean(getProviderKey("CEREBRAS_API_KEY"));
  }

  if (getVercelAIGatewayApiKey()) {
    return true;
  }

  if (isOpenAINativeModel(model)) {
    return Boolean(getProviderKey("OPENAI_API_KEY"));
  }

  if (isAnthropicNativeModel(model)) {
    return Boolean(getProviderKey("ANTHROPIC_API_KEY"));
  }

  return false;
}

export function hasTextEmbeddingProviderConfigured(): boolean {
  return Boolean(
    getBitRouterApiKey() || getVercelAIGatewayApiKey() || getProviderKey("OPENAI_API_KEY"),
  );
}

export function getLanguageModel(model: string) {
  if (isGroqNativeModel(model)) {
    return getGroqClient().languageModel(getGroqApiModelId(model));
  }

  if (isVastNativeModel(model)) {
    const { client, apiModelId } = getVastClient(model);
    return client.languageModel(apiModelId);
  }

  if (getBitRouterApiKey()) {
    return getBitRouterClient().languageModel(toOpenRouterModelId(model));
  }

  if (requiresOpenRouterRouting(model)) {
    throw new Error("BITROUTER_API_KEY environment variable is required for this model");
  }

  if (isCerebrasNativeModel(model) && getProviderKey("CEREBRAS_API_KEY")) {
    return getCerebrasClient().chat(normalizeCerebrasModelId(model));
  }

  if (getVercelAIGatewayApiKey()) {
    return getVercelAIGatewayClient().languageModel(model as never);
  }

  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    const modelId = normalizeOpenAIModelId(model);
    return getProviderKey("OPENAI_BASE_URL")
      ? getOpenAIClient().chat(modelId)
      : getOpenAIClient().languageModel(modelId);
  }

  if (isAnthropicNativeModel(model) && getProviderKey("ANTHROPIC_API_KEY")) {
    return getAnthropicClient().languageModel(normalizeAnthropicModelId(model));
  }

  throw new Error("AI language model provider is not configured");
}

export function getTextEmbeddingModel(model: string) {
  if (getBitRouterApiKey()) {
    return getBitRouterClient().textEmbeddingModel(toOpenRouterModelId(model));
  }

  if (getVercelAIGatewayApiKey()) {
    return getVercelAIGatewayClient().embeddingModel(model as never);
  }

  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    return getOpenAIClient().textEmbeddingModel(normalizeOpenAIModelId(model));
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

  if (getBitRouterApiKey()) {
    return "bitrouter";
  }

  if (requiresOpenRouterRouting(model)) {
    return null;
  }

  if (isCerebrasNativeModel(model)) {
    return getProviderKey("CEREBRAS_API_KEY") ? "cerebras" : null;
  }

  if (getVercelAIGatewayApiKey()) {
    return "gateway";
  }

  if (isOpenAINativeModel(model) && getProviderKey("OPENAI_API_KEY")) {
    return "openai";
  }

  if (isAnthropicNativeModel(model) && getProviderKey("ANTHROPIC_API_KEY")) {
    return "anthropic";
  }

  return null;
}

export function resolveEmbeddingProviderSource(): "bitrouter" | "gateway" | "openai" | null {
  if (getBitRouterApiKey()) {
    return "bitrouter";
  }

  if (getVercelAIGatewayApiKey()) {
    return "gateway";
  }

  if (getProviderKey("OPENAI_API_KEY")) {
    return "openai";
  }

  return null;
}

export function hasAnyAiProviderConfigured(): boolean {
  return Boolean(
    getBitRouterApiKey() ||
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
    bitrouter: Boolean(getBitRouterApiKey()),
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
