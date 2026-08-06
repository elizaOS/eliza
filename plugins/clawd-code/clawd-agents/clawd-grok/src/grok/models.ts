/**
 * Model definitions and provider routing metadata for the Clawd harness.
 */

export const PROVIDERS = ["xai", "zai", "openai", "openrouter", "deepseek", "custom"] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  description: string;
  envKey: string;
  envBaseURL?: string;
  defaultBaseURL: string;
  openAICompatible: boolean;
  supportsNativeSearch?: boolean;
  supportsNativeMedia?: boolean;
}

export interface ModelDefinition {
  id: string;
  provider: ProviderId;
  name: string;
  description: string;
  contextWindow: number;
  inputPrice: number; // per 1M tokens
  outputPrice: number; // per 1M tokens
  reasoning?: boolean;
  multiAgent?: boolean;
  responsesOnly?: boolean;
  supportsClientTools?: boolean;
  supportsMaxOutputTokens?: boolean;
  reasoningEfforts?: string[];
  bestFor?: string[];
  aliases?: string[];
}

export const DEFAULT_MODEL = "grok-4.3";
export const DEFAULT_PROVIDER: ProviderId = "xai";

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "xai",
    name: "xAI",
    description: "Native xAI provider for Grok chat, Responses search, X search, image, and video models.",
    envKey: "XAI_API_KEY",
    envBaseURL: "XAI_BASE_URL",
    defaultBaseURL: "https://api.x.ai/v1",
    openAICompatible: false,
    supportsNativeSearch: true,
    supportsNativeMedia: true,
  },
  {
    id: "zai",
    name: "Z.AI",
    description: "OpenAI-compatible Z.AI GLM models for coding and fast agent turns.",
    envKey: "ZAI_API_KEY",
    envBaseURL: "ZAI_BASE_URL",
    defaultBaseURL: "https://api.z.ai/api/paas/v4",
    openAICompatible: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI chat models through the OpenAI-compatible interface.",
    envKey: "OPENAI_API_KEY",
    envBaseURL: "OPENAI_BASE_URL",
    defaultBaseURL: "https://api.openai.com/v1",
    openAICompatible: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "OpenRouter-hosted models with explicit upstream model ids.",
    envKey: "OPENROUTER_API_KEY",
    envBaseURL: "OPENROUTER_BASE_URL",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    openAICompatible: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek OpenAI-compatible coding and reasoning models.",
    envKey: "DEEPSEEK_API_KEY",
    envBaseURL: "DEEPSEEK_BASE_URL",
    defaultBaseURL: "https://api.deepseek.com",
    openAICompatible: true,
  },
  {
    id: "custom",
    name: "Custom",
    description: "Any OpenAI-compatible endpoint configured with CLAWD_API_KEY and CLAWD_BASE_URL.",
    envKey: "CLAWD_API_KEY",
    envBaseURL: "CLAWD_BASE_URL",
    defaultBaseURL: "",
    openAICompatible: true,
  },
];

export const MODELS: ModelDefinition[] = [
  {
    id: "grok-4.3",
    provider: "xai",
    name: "Grok 4.3",
    description: "xAI flagship reasoning model — best for agent tasks, code, and market analysis",
    contextWindow: 256_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    bestFor: ["coding", "agent", "reasoning"],
    aliases: ["grok-4-1-fast", "xai/grok-code-fast-1"],
  },
  {
    id: "grok-4.20-non-reasoning",
    provider: "xai",
    name: "Grok 4.20 (Non-reasoning)",
    description: "Fast, cost-effective Grok model without extended reasoning — good for quick tasks",
    contextWindow: 256_000,
    inputPrice: 2.0,
    outputPrice: 10.0,
    supportsClientTools: true,
    bestFor: ["fast", "summaries"],
    aliases: ["grok-4.20-0309-non-reasoning", "x-ai/grok-3"],
  },
  {
    id: "grok-4.20-multi-agent-0309",
    provider: "xai",
    name: "Grok 4.20 Multi-Agent",
    description: "Specialized Grok model for multi-agent orchestration — responses API only",
    contextWindow: 256_000,
    inputPrice: 2.0,
    outputPrice: 10.0,
    multiAgent: true,
    responsesOnly: true,
    supportsClientTools: false,
    bestFor: ["multi-agent"],
    aliases: ["grok-4.20-multi-agent", "x-ai/grok-4.20-multi-agent-beta"],
  },
  {
    id: "grok-4.20-0309-reasoning",
    provider: "xai",
    name: "Grok 4.20 Reasoning",
    description: "Grok model with extended chain-of-thought reasoning for complex problems",
    contextWindow: 256_000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    reasoning: true,
    supportsClientTools: true,
    bestFor: ["reasoning", "analysis"],
    aliases: ["grok-4.20-reasoning"],
  },
  {
    id: "grok-3-mini",
    provider: "xai",
    name: "Grok 3 Mini",
    description: "Small, fast Grok model with configurable reasoning effort — great for quick agent tasks",
    contextWindow: 131_072,
    inputPrice: 0.3,
    outputPrice: 0.5,
    reasoning: true,
    supportsClientTools: true,
    reasoningEfforts: ["low", "high"],
    bestFor: ["fast", "low-cost"],
    aliases: ["grok3-mini"],
  },
  {
    id: "grok-3",
    provider: "xai",
    name: "Grok 3",
    description: "Capable, balanced Grok model — strong at reasoning and tool use",
    contextWindow: 131_072,
    inputPrice: 3.0,
    outputPrice: 15.0,
    supportsClientTools: true,
    bestFor: ["general"],
    aliases: ["grok3"],
  },
  {
    id: "grok-code-fast-1",
    provider: "xai",
    name: "Grok Code Fast",
    description: "Grok model optimized for code generation and agentic coding tasks",
    contextWindow: 256_000,
    inputPrice: 1.0,
    outputPrice: 5.0,
    supportsClientTools: true,
    bestFor: ["coding", "fast"],
    aliases: ["grok-code"],
  },
  {
    id: "glm-5.2",
    provider: "zai",
    name: "GLM 5.2",
    description: "Z.AI flagship OpenAI-compatible model for deep coding and agentic reasoning",
    contextWindow: 256_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    bestFor: ["coding", "agent", "reasoning"],
    aliases: ["zai:glm-5.2", "zai/glm-5.2"],
  },
  {
    id: "glm-5-turbo",
    provider: "zai",
    name: "GLM 5 Turbo",
    description: "Fast Z.AI model for quick code edits, summaries, and tool orchestration",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    bestFor: ["fast", "coding"],
    aliases: ["zai:glm-5-turbo", "zai/glm-5-turbo"],
  },
  {
    id: "glm-5v-turbo",
    provider: "zai",
    name: "GLM 5V Turbo",
    description: "Z.AI vision-capable model for screenshots, camera frames, and image-aware tasks",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    bestFor: ["vision", "screenshots"],
    aliases: ["zai:glm-5v-turbo", "zai/glm-5v-turbo"],
  },
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    description: "OpenAI general-purpose multimodal model through the OpenAI-compatible route",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    bestFor: ["general", "vision"],
    aliases: ["openai:gpt-4o", "openai/gpt-4o"],
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o mini",
    description: "OpenAI fast, low-cost model for lightweight tool and coding tasks",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    bestFor: ["fast", "low-cost"],
    aliases: ["openai:gpt-4o-mini", "openai/gpt-4o-mini"],
  },
  {
    id: "auto",
    provider: "openrouter",
    name: "OpenRouter Auto",
    description: "OpenRouter automatic model routing for general chat and agent tasks",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    bestFor: ["routing", "fallback"],
    aliases: ["openrouter:auto", "openrouter/auto"],
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    name: "Nemotron 3 Ultra 550B Free",
    description: "OpenRouter-hosted Nemotron route for large-model reasoning where available",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    bestFor: ["reasoning", "openrouter"],
    aliases: ["openrouter:nemotron-ultra-free", "nemotron-ultra-free"],
  },
  {
    id: "anthropic/claude-fable-5",
    provider: "openrouter",
    name: "Claude Fable 5 via OpenRouter",
    description: "OpenRouter Anthropic model route for coding and long-form reasoning",
    contextWindow: 200_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    bestFor: ["coding", "writing", "reasoning"],
    aliases: ["openrouter:claude-fable-5", "claude-fable-5"],
  },
  {
    id: "deepseek-chat",
    provider: "deepseek",
    name: "DeepSeek Chat",
    description: "DeepSeek OpenAI-compatible chat model for coding and general agent work",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    supportsClientTools: true,
    bestFor: ["coding", "general"],
    aliases: ["deepseek:deepseek-chat", "deepseek-chat"],
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    name: "DeepSeek Reasoner",
    description: "DeepSeek reasoning model for harder coding and analysis tasks",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: true,
    supportsClientTools: true,
    bestFor: ["reasoning", "analysis"],
    aliases: ["deepseek:deepseek-reasoner", "deepseek-reasoner"],
  },
];

const MODEL_BY_ID = new Map<string, ModelDefinition>();
const ALIAS_MAP = new Map<string, string>();

for (const m of MODELS) {
  MODEL_BY_ID.set(m.id, m);
  ALIAS_MAP.set(m.id.toLowerCase(), m.id);
  for (const alias of m.aliases ?? []) {
    ALIAS_MAP.set(alias.toLowerCase(), m.id);
  }
}

export function getModel(id: string): ModelDefinition | undefined {
  const canonical = ALIAS_MAP.get(id.toLowerCase()) ?? ALIAS_MAP.get(stripProviderPrefix(id).toLowerCase());
  return canonical ? MODEL_BY_ID.get(canonical) : MODEL_BY_ID.get(id);
}

export function getModelInfo(id: string): ModelDefinition | undefined {
  return getModel(id);
}

export function normalizeModelId(id: string): string {
  const trimmed = id.trim();
  const providerPrefix = parseModelProviderPrefix(trimmed);
  const unprefixed = providerPrefix ? providerPrefix.model : trimmed;
  const canonical = ALIAS_MAP.get(trimmed.toLowerCase()) ?? ALIAS_MAP.get(unprefixed.toLowerCase());
  return canonical ?? unprefixed;
}

export function listModelIds(): string[] {
  return MODELS.map((m) => m.id);
}

export function getModelIds(): string[] {
  return listModelIds();
}

export function isProviderId(value: string | undefined): value is ProviderId {
  return Boolean(value && PROVIDERS.includes(value.toLowerCase() as ProviderId));
}

export function normalizeProviderId(value: string | undefined): ProviderId | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return isProviderId(normalized) ? normalized : undefined;
}

export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  return PROVIDER_DEFINITIONS.find((provider) => provider.id === id) ?? PROVIDER_DEFINITIONS[0];
}

export function getModelProvider(id: string): ProviderId | undefined {
  const explicit = parseModelProviderPrefix(id)?.provider;
  if (explicit) return explicit;
  return getModel(id)?.provider;
}

export function resolveModelRoute(modelId: string, provider?: ProviderId): { provider: ProviderId; modelId: string } {
  const explicit = parseModelProviderPrefix(modelId);
  const normalizedModelId = normalizeModelId(modelId);
  const modelProvider = getModel(normalizedModelId)?.provider;
  return {
    provider: explicit?.provider ?? provider ?? modelProvider ?? DEFAULT_PROVIDER,
    modelId: normalizedModelId,
  };
}

export function listProviders(): ProviderDefinition[] {
  return [...PROVIDER_DEFINITIONS];
}

function parseModelProviderPrefix(id: string): { provider: ProviderId; model: string } | undefined {
  const trimmed = id.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const provider = normalizeProviderId(trimmed.slice(0, colonIndex));
    if (provider) {
      const model = trimmed.slice(colonIndex + 1).trim();
      if (model) return { provider, model };
    }
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    const provider = normalizeProviderId(trimmed.slice(0, slashIndex));
    if (provider) {
      const model = trimmed.slice(slashIndex + 1).trim();
      if (model) return { provider, model };
    }
  }

  return undefined;
}

function stripProviderPrefix(id: string): string {
  return parseModelProviderPrefix(id)?.model ?? id.trim();
}

export function getSupportedReasoningEfforts(id: string): string[] {
  const info = getModel(id);
  return info?.reasoningEfforts ?? [];
}

export function getEffectiveReasoningEffort(id: string, effort?: string): string | undefined {
  const supported = getSupportedReasoningEfforts(id);
  if (supported.length === 0) return undefined;
  if (effort && supported.includes(effort)) return effort;
  return undefined;
}
