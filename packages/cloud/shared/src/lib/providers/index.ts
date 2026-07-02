/**
 * AI provider implementations and singleton access.
 *
 * The Worker calls each provider DIRECTLY when we hold its native key (Groq,
 * Vast, OpenAI, Anthropic). OpenRouter (BYOK) is the backup: it serves models we
 * have no native key for, and is the per-family failover target via
 * `getProviderForModelWithFallback`.
 */

import { CEREBRAS_NATIVE_TEXT_MODELS, isGroqNativeModel, isVastNativeModel } from "../models";
import { AnthropicDirectProvider } from "./anthropic-direct";
import { CerebrasDirectProvider } from "./cerebras-direct";
import { GroqProvider } from "./groq";
import { canonicalizeCerebrasModelId } from "./language-model";
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
export { CerebrasDirectProvider } from "./cerebras-direct";
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

let groqProviderInstance: ProviderSingleton | null = null;
let cerebrasDirectProviderInstance: ProviderSingleton | null = null;
let openAIDirectProviderInstance: OpenAIDirectProviderSingleton | null = null;
let anthropicDirectProviderInstance: ProviderSingleton | null = null;
let openRouterProviderInstance: OpenAIDirectProviderSingleton | null = null;
let vercelAIGatewayProviderInstance: ProviderSingleton | null = null;
let vastProviderInstances = new Map<string, AIProvider>();

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

function cerebrasModelId(model: string): string | null {
  const canonical = canonicalizeCerebrasModelId(model);
  return CEREBRAS_NATIVE_TEXT_MODELS.includes(
    canonical as (typeof CEREBRAS_NATIVE_TEXT_MODELS)[number],
  )
    ? canonical
    : null;
}

function isCerebrasCatalogModel(model: string): boolean {
  let id = model.trim();
  if (id.startsWith("openai/")) id = id.slice("openai/".length);
  else if (id.startsWith("cerebras/")) id = id.slice("cerebras/".length);
  else if (id.startsWith("cerebras:")) id = id.slice("cerebras:".length);
  const baseId = id.split(":")[0];
  return CEREBRAS_NATIVE_TEXT_MODELS.includes(
    baseId as (typeof CEREBRAS_NATIVE_TEXT_MODELS)[number],
  );
}

function hasCerebrasDirectConfigured(): boolean {
  return Boolean(getProviderKey("CEREBRAS_API_KEY"));
}

function getCerebrasDirectProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("CEREBRAS_API_KEY");
  if (!cerebrasDirectProviderInstance || cerebrasDirectProviderInstance.apiKey !== apiKey) {
    cerebrasDirectProviderInstance = {
      apiKey,
      provider: new CerebrasDirectProvider(apiKey),
    };
  }
  return cerebrasDirectProviderInstance.provider;
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

export function hasOpenRouterProviderConfigured(): boolean {
  return Boolean(getProviderKey("OPENROUTER_API_KEY"));
}

/**
 * OpenRouter direct provider (BYOK) — the backup for models we have no native
 * key for, and the per-family failover target. See `getProviderForModelWithFallback`.
 */
export function getOpenRouterProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("OPENROUTER_API_KEY");
  const baseUrl = getProviderKey("OPENROUTER_BASE_URL") ?? undefined;
  if (
    !openRouterProviderInstance ||
    openRouterProviderInstance.apiKey !== apiKey ||
    openRouterProviderInstance.baseUrl !== baseUrl
  ) {
    openRouterProviderInstance = {
      apiKey,
      baseUrl,
      provider: new OpenRouterProvider(apiKey, baseUrl),
    };
  }
  return openRouterProviderInstance.provider;
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

  const directCerebrasModel = cerebrasModelId(model);
  if (directCerebrasModel || isCerebrasCatalogModel(model)) {
    if (directCerebrasModel && hasCerebrasDirectConfigured()) {
      return getCerebrasDirectProvider();
    }
    if (hasOpenRouterProviderConfigured()) {
      return getOpenRouterProvider();
    }
    return getVercelAIGatewayProvider();
  }

  if (model.startsWith("openai/") && hasOpenAIDirectConfigured()) {
    return getOpenAIDirectProvider();
  }

  if (model.startsWith("anthropic/") && hasAnthropicDirectConfigured()) {
    return getAnthropicDirectProvider();
  }

  if (hasOpenRouterProviderConfigured()) {
    return getOpenRouterProvider();
  }

  return getVercelAIGatewayProvider();
}

/**
 * Returns primary + fallback providers for a model. Routes (chat/completions,
 * responses, embeddings, apps/[id]/chat) use this for automatic 402/429 failover
 * via `withProviderFallback`.
 *
 * Direct-first: native providers serve their own models (no hop); OpenRouter
 * (BYOK) is the backup.
 *   - Groq native: no fallback.
 *   - Vast native: fallback to a smaller Vast endpoint (27B -> 9B -> 2B).
 *   - `openai/*` (+ OPENAI_API_KEY): OpenAI direct, OpenRouter on-error fallback.
 *   - `anthropic/*` (+ ANTHROPIC_API_KEY): Anthropic direct, OpenRouter fallback.
 *   - Everything else (no native key — xai, google, mistral, …): OpenRouter is
 *     the direct gateway (no further fallback), else the dev Vercel gateway.
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

  const openRouterBackup = hasOpenRouterProviderConfigured() ? getOpenRouterProvider() : null;

  const directCerebrasModel = cerebrasModelId(model);
  if (directCerebrasModel || isCerebrasCatalogModel(model)) {
    if (directCerebrasModel && hasCerebrasDirectConfigured()) {
      return { primary: getCerebrasDirectProvider(), fallback: null };
    }
    if (openRouterBackup) {
      return { primary: openRouterBackup, fallback: null };
    }
    return { primary: getVercelAIGatewayProvider(), fallback: null };
  }

  if (model.startsWith("openai/") && hasOpenAIDirectConfigured()) {
    return { primary: getOpenAIDirectProvider(), fallback: openRouterBackup };
  }

  if (model.startsWith("anthropic/") && hasAnthropicDirectConfigured()) {
    return { primary: getAnthropicDirectProvider(), fallback: openRouterBackup };
  }

  // No native key for this model: OpenRouter is the direct gateway.
  if (openRouterBackup) {
    return { primary: openRouterBackup, fallback: null };
  }

  return { primary: getVercelAIGatewayProvider(), fallback: null };
}
