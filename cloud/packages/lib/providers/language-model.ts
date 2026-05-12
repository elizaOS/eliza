import { createAnthropic } from "@ai-sdk/anthropic";
import { createGatewayProvider, type GatewayProvider } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import {
  getGroqApiModelId,
  getVastApiModelId,
  isGroqNativeModel,
  isVastNativeModel,
  OPENROUTER_DEFAULT_FREE_MODEL,
  OPENROUTER_RECOMMENDED_TEXT_MODEL,
} from "@/lib/models";
import { toOpenRouterModelId } from "./model-id-translation";
import { getProviderKey } from "./provider-env";

let groqClient: ReturnType<typeof createOpenAI> | null = null;
let vastClient: ReturnType<typeof createOpenAI> | null = null;
let openAIClient: {
  apiKey: string;
  baseURL?: string;
  client: ReturnType<typeof createOpenAI>;
} | null = null;
let openRouterClient: ReturnType<typeof createOpenAI> | null = null;
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

function getVastClient() {
  if (!vastClient) {
    const apiKey = getProviderKey("VAST_API_KEY");
    const baseUrl = getProviderKey("VAST_BASE_URL");
    if (!apiKey || !baseUrl) {
      throw new Error("VAST_API_KEY and VAST_BASE_URL environment variables are required");
    }
    const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    vastClient = createOpenAI({
      apiKey,
      baseURL: `${trimmed}/v1`,
    });
  }

  return vastClient;
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

function getOpenRouterApiKey(): string | null {
  return getProviderKey("OPENROUTER_API_KEY");
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
      baseURL: "https://openrouter.ai/api/v1",
    });
  }

  return openRouterClient;
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
 * True iff a gateway-style provider is configured. OpenRouter stays first
 * when present; Vercel AI Gateway is the local/dev fallback.
 */
export function hasGatewayProviderConfigured(): boolean {
  return getOpenRouterApiKey() !== null || getVercelAIGatewayApiKey() !== null;
}

export function hasLanguageModelProviderConfigured(model: string): boolean {
  if (isGroqNativeModel(model)) {
    return Boolean(getProviderKey("GROQ_API_KEY"));
  }

  if (isVastNativeModel(model)) {
    return Boolean(getProviderKey("VAST_API_KEY") && getProviderKey("VAST_BASE_URL"));
  }

  if (getOpenRouterApiKey()) {
    return true;
  }

  if (requiresOpenRouterRouting(model)) {
    return false;
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
    getOpenRouterApiKey() || getVercelAIGatewayApiKey() || getProviderKey("OPENAI_API_KEY"),
  );
}

export function getLanguageModel(model: string) {
  if (isGroqNativeModel(model)) {
    return getGroqClient().languageModel(getGroqApiModelId(model));
  }

  if (isVastNativeModel(model)) {
    return getVastClient().languageModel(getVastApiModelId(model));
  }

  if (getOpenRouterApiKey()) {
    return getOpenRouterClient().languageModel(toOpenRouterModelId(model));
  }

  if (requiresOpenRouterRouting(model)) {
    throw new Error("OPENROUTER_API_KEY environment variable is required for this model");
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
  if (getOpenRouterApiKey()) {
    return getOpenRouterClient().textEmbeddingModel(toOpenRouterModelId(model));
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
): "groq" | "vast" | "openrouter" | "gateway" | "openai" | "anthropic" | null {
  if (isGroqNativeModel(model)) {
    return getProviderKey("GROQ_API_KEY") ? "groq" : null;
  }

  if (isVastNativeModel(model)) {
    return getProviderKey("VAST_API_KEY") && getProviderKey("VAST_BASE_URL") ? "vast" : null;
  }

  if (getOpenRouterApiKey()) {
    return "openrouter";
  }

  if (requiresOpenRouterRouting(model)) {
    return null;
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

export function resolveEmbeddingProviderSource(): "openrouter" | "gateway" | "openai" | null {
  if (getOpenRouterApiKey()) {
    return "openrouter";
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
    getOpenRouterApiKey() ||
      getVercelAIGatewayApiKey() ||
      getProviderKey("OPENAI_API_KEY") ||
      getProviderKey("ANTHROPIC_API_KEY") ||
      getProviderKey("GROQ_API_KEY") ||
      (getProviderKey("VAST_API_KEY") && getProviderKey("VAST_BASE_URL")),
  );
}

export function getAiProviderConfigurationStatus() {
  return {
    openrouter: Boolean(getOpenRouterApiKey()),
    gateway: Boolean(getVercelAIGatewayApiKey()),
    openai: Boolean(getProviderKey("OPENAI_API_KEY")),
    anthropic: Boolean(getProviderKey("ANTHROPIC_API_KEY")),
    groq: Boolean(getProviderKey("GROQ_API_KEY")),
    vast: Boolean(getProviderKey("VAST_API_KEY") && getProviderKey("VAST_BASE_URL")),
  };
}

export function getAiProviderConfigurationSummary(): string {
  const status = getAiProviderConfigurationStatus();
  const configured = Object.entries(status)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return configured.length > 0 ? configured.join(", ") : "none";
}
