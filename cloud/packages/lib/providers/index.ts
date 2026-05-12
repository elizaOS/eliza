/**
 * AI provider implementations and singleton access.
 *
 * OpenRouter is the principal non-Groq provider. Per-family direct
 * providers (OpenAI, Anthropic) are wired as failover targets via
 * `getProviderForModelWithFallback` when their respective API keys
 * are configured.
 */

import { isGroqNativeModel, isVastNativeModel } from "@/lib/models";
import { AnthropicDirectProvider } from "./anthropic-direct";
import { GroqProvider } from "./groq";
import { OpenAIDirectProvider } from "./openai-direct";
import { OpenRouterProvider } from "./openrouter";
import { getProviderKey, getRequiredProviderKey } from "./provider-env";
import type { AIProvider } from "./types";
import { VastProvider } from "./vast";
import { resolveVastEndpointConfig, resolveVastFallbackModel } from "./vast-endpoints";
import { VercelAIGatewayProvider } from "./vercel-ai-gateway";

export { AnthropicDirectProvider } from "./anthropic-direct";
// Note: anthropic-thinking parse helpers (parseAnthropicCotBudgetFromEnv, etc.) are exported
// as public API. Whitespace-only env values (e.g. "   ") will throw at startup rather than
// silently disable thinking - this is intentional fail-fast behavior.
export * from "./anthropic-thinking";
export { withProviderFallback } from "./failover";
export { GroqProvider } from "./groq";
export { OpenAIDirectProvider } from "./openai-direct";
export { OpenRouterProvider } from "./openrouter";
export * from "./types";
export { VastProvider } from "./vast";
export * from "./vast-endpoints";
export { VercelAIGatewayProvider } from "./vercel-ai-gateway";

interface ProviderSingleton {
  apiKey: string;
  provider: AIProvider;
}

interface OpenAIDirectProviderSingleton extends ProviderSingleton {
  baseUrl?: string;
}

let openRouterProviderInstance: ProviderSingleton | null = null;
let groqProviderInstance: ProviderSingleton | null = null;
let openAIDirectProviderInstance: OpenAIDirectProviderSingleton | null = null;
let anthropicDirectProviderInstance: ProviderSingleton | null = null;
let vercelAIGatewayProviderInstance: ProviderSingleton | null = null;
let vastProviderInstances = new Map<string, AIProvider>();

/**
 * Gets the principal AI provider instance (OpenRouter).
 *
 * Lazy initialized on first call.
 *
 * @returns OpenRouter provider instance.
 * @throws Error if OPENROUTER_API_KEY is not configured.
 */
export function getProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("OPENROUTER_API_KEY");
  if (!openRouterProviderInstance || openRouterProviderInstance.apiKey !== apiKey) {
    openRouterProviderInstance = {
      apiKey,
      provider: new OpenRouterProvider(apiKey),
    };
  }
  return openRouterProviderInstance.provider;
}

export function hasGroqProviderConfigured(): boolean {
  return Boolean(getProviderKey("GROQ_API_KEY"));
}

export function getGroqProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("GROQ_API_KEY");
  if (!groqProviderInstance || groqProviderInstance.apiKey !== apiKey) {
    groqProviderInstance = {
      apiKey,
      provider: new GroqProvider(apiKey),
    };
  }

  return groqProviderInstance.provider;
}

export function hasOpenRouterProviderConfigured(): boolean {
  return Boolean(getProviderKey("OPENROUTER_API_KEY"));
}

export function getOpenRouterProvider(): AIProvider {
  return getProvider();
}

function hasOpenAIDirectConfigured(): boolean {
  return Boolean(getProviderKey("OPENAI_API_KEY"));
}

function getOpenAIDirectProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("OPENAI_API_KEY");
  const baseUrl = getProviderKey("OPENAI_BASE_URL") ?? undefined;
  if (
    !openAIDirectProviderInstance ||
    openAIDirectProviderInstance.apiKey !== apiKey ||
    openAIDirectProviderInstance.baseUrl !== baseUrl
  ) {
    openAIDirectProviderInstance = {
      apiKey,
      baseUrl,
      provider: new OpenAIDirectProvider(apiKey, baseUrl),
    };
  }
  return openAIDirectProviderInstance.provider;
}

function hasAnthropicDirectConfigured(): boolean {
  return Boolean(getProviderKey("ANTHROPIC_API_KEY"));
}

function getAnthropicDirectProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("ANTHROPIC_API_KEY");
  if (!anthropicDirectProviderInstance || anthropicDirectProviderInstance.apiKey !== apiKey) {
    anthropicDirectProviderInstance = {
      apiKey,
      provider: new AnthropicDirectProvider(apiKey),
    };
  }
  return anthropicDirectProviderInstance.provider;
}

export function hasVastProviderConfigured(model = "vast/eliza-1-27b"): boolean {
  return resolveVastEndpointConfig(model) !== null;
}

export function getVastProvider(model = "vast/eliza-1-27b"): AIProvider {
  const config = resolveVastEndpointConfig(model);
  if (!config) {
    throw new Error(`Vast endpoint is not configured for ${model}`);
  }
  const cacheKey = `${config.model}|${config.apiKey}|${config.baseUrl}|${config.apiModelId}`;
  const cached = vastProviderInstances.get(cacheKey);
  if (cached) return cached;
  const provider = new VastProvider(config.apiKey, config.baseUrl, {
    apiModelId: config.apiModelId,
  });
  vastProviderInstances.set(cacheKey, provider);
  return provider;
}

function getVercelAIGatewayApiKey(): string | null {
  return getProviderKey("AI_GATEWAY_API_KEY") ?? getProviderKey("AIGATEWAY_API_KEY");
}

function getVercelAIGatewayBaseURL(): string | undefined {
  return getProviderKey("AI_GATEWAY_BASE_URL") ?? undefined;
}

export function hasVercelAIGatewayProviderConfigured(): boolean {
  return Boolean(getVercelAIGatewayApiKey());
}

export function getVercelAIGatewayProvider(): AIProvider {
  const apiKey = getVercelAIGatewayApiKey();
  if (!apiKey) {
    throw new Error("AI_GATEWAY_API_KEY environment variable is required");
  }

  if (!vercelAIGatewayProviderInstance || vercelAIGatewayProviderInstance.apiKey !== apiKey) {
    vercelAIGatewayProviderInstance = {
      apiKey,
      provider: new VercelAIGatewayProvider(apiKey, getVercelAIGatewayBaseURL()),
    };
  }
  return vercelAIGatewayProviderInstance.provider;
}

export function getProviderForModel(model: string): AIProvider {
  if (isGroqNativeModel(model)) {
    return getGroqProvider();
  }

  if (isVastNativeModel(model)) {
    return getVastProvider(model);
  }

  if (hasOpenRouterProviderConfigured()) {
    return getProvider();
  }

  if (hasVercelAIGatewayProviderConfigured()) {
    return getVercelAIGatewayProvider();
  }

  return getProvider();
}

/**
 * Returns primary + fallback providers for a model.
 *
 * Routes used by chat/completions, responses, embeddings, and apps/[id]/chat
 * call this to enable automatic 402/429 failover via `withProviderFallback`.
 *
 * Fallback rules:
 *   - Groq native models: no fallback (Groq runs through its own provider).
 *   - Vast native models: fallback to a smaller dedicated Vast endpoint when
 *     configured (27B -> 9B -> 2B by default).
 *   - `openai/*`: OpenAI direct fallback when OPENAI_API_KEY is set.
 *   - `anthropic/*`: Anthropic direct fallback when ANTHROPIC_API_KEY is set.
 *   - All other models (xai, google, mistral, …): no fallback.
 */
export function getProviderForModelWithFallback(model: string): {
  primary: AIProvider;
  fallback: AIProvider | null;
} {
  if (isGroqNativeModel(model)) {
    return { primary: getGroqProvider(), fallback: null };
  }

  if (isVastNativeModel(model)) {
    const fallbackModel = resolveVastFallbackModel(model);
    return {
      primary: getVastProvider(model),
      fallback: fallbackModel ? getVastProvider(fallbackModel) : null,
    };
  }

  const primary = hasOpenRouterProviderConfigured() ? getProvider() : getVercelAIGatewayProvider();

  if (model.startsWith("openai/") && hasOpenAIDirectConfigured()) {
    return { primary, fallback: getOpenAIDirectProvider() };
  }

  if (model.startsWith("anthropic/") && hasAnthropicDirectConfigured()) {
    return { primary, fallback: getAnthropicDirectProvider() };
  }

  return { primary, fallback: null };
}
