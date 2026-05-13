import { normalizeProviderKey } from "@/lib/providers/model-id-translation";

export interface CatalogModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  released?: number;
  name?: string;
  description?: string;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  context_length?: number;
  context_window?: number;
  max_tokens?: number;
  type?: string;
  tags?: string[];
  pricing?: Record<string, unknown>;
  recommended?: boolean;
  free?: boolean;
}

export interface SelectorModel {
  id: string;
  name: string;
  description: string;
  modelId: string;
  provider: string;
  recommended?: boolean;
  free?: boolean;
}

export const OPENROUTER_RECOMMENDED_TEXT_MODEL = "openai/gpt-oss-120b:nitro";
export const OPENROUTER_DEFAULT_TEXT_MODEL = OPENROUTER_RECOMMENDED_TEXT_MODEL;
export const OPENROUTER_DEFAULT_FREE_MODEL = "openai/gpt-oss-120b:free";

const OPENROUTER_RECOMMENDED_MODEL_IDS = new Set<string>([OPENROUTER_RECOMMENDED_TEXT_MODEL]);

// Verified against the public provider catalogs on 2026-04-25:
// - OpenRouter: https://openrouter.ai/api/v1/models
// - Groq docs: https://console.groq.com/docs/models
const OPENROUTER_FEATURED_TEXT_MODELS: CatalogModel[] = [
  {
    id: OPENROUTER_RECOMMENDED_TEXT_MODEL,
    object: "model",
    created: 0,
    owned_by: "openai",
    name: "GPT OSS 120B Nitro",
    description: "Recommended OpenRouter high-throughput open-weight reasoning model",
    type: "language",
    context_window: 131072,
    tags: ["recommended", "reasoning", "open-weight", "nitro"],
    recommended: true,
  },
  {
    id: "openai/gpt-oss-120b",
    object: "model",
    created: 0,
    owned_by: "openai",
    name: "GPT OSS 120B",
    description: "OpenRouter open-weight reasoning model",
    type: "language",
    context_window: 131072,
    tags: ["reasoning", "open-weight"],
  },
  {
    id: OPENROUTER_DEFAULT_FREE_MODEL,
    object: "model",
    created: 0,
    owned_by: "openai",
    name: "GPT OSS 120B Free",
    description: "Free OpenRouter open-weight reasoning model",
    type: "language",
    context_window: 131072,
    pricing: {
      prompt: "0",
      completion: "0",
    },
    tags: ["free", "reasoning", "open-weight"],
    free: true,
  },
];

const OPENAI_TEXT_MODEL_IDS = [
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5",
  "openai/gpt-5-pro",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-5.2",
  "openai/gpt-5.2-pro",
  "openai/gpt-5.3-chat",
  "openai/gpt-5.3-codex",
  "openai/o4-mini",
  "openai/o3",
  "openai/o3-pro",
] as const;

const ANTHROPIC_TEXT_MODEL_IDS = [
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
] as const;

const GOOGLE_TEXT_MODEL_IDS = [
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-3-pro-preview",
  "google/gemini-3-flash",
] as const;

const XAI_TEXT_MODEL_IDS = [
  "x-ai/grok-4",
  "x-ai/grok-4-fast-reasoning",
  "x-ai/grok-4-fast-non-reasoning",
  "x-ai/grok-4.1-fast-reasoning",
  "x-ai/grok-4.1-fast-non-reasoning",
  "x-ai/grok-4.20-reasoning",
  "x-ai/grok-4.20-non-reasoning",
  "x-ai/grok-4.20-multi-agent",
  "x-ai/grok-code-fast-1",
  "x-ai/grok-3-mini",
  "x-ai/grok-3-mini-fast",
] as const;
const MISTRAL_TEXT_MODEL_IDS = [
  "mistralai/magistral-medium",
  "mistralai/magistral-small",
  "mistralai/mistral-large-3",
  "mistralai/mistral-medium",
  "mistralai/codestral",
  "mistralai/devstral-2",
  "mistralai/ministral-8b",
] as const;
const MINIMAX_TEXT_MODEL_IDS = [
  "minimax/minimax-m2.7",
  "minimax/minimax-m2.5",
  "minimax/minimax-m2.1-lightning",
] as const;
const DEEPSEEK_TEXT_MODEL_IDS = [
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-r1",
] as const;
const ZAI_TEXT_MODEL_IDS = ["zai/glm-5.1", "zai/glm-5-turbo"] as const;
const MOONSHOT_TEXT_MODEL_IDS = ["moonshotai/kimi-k2.6"] as const;
const BYTEDANCE_TEXT_MODEL_IDS = ["bytedance/seed-1.8", "bytedance/seed-1.6"] as const;
const AMAZON_TEXT_MODEL_IDS = [
  "amazon/nova-2-lite",
  "amazon/nova-pro",
  "amazon/nova-lite",
  "amazon/nova-micro",
] as const;
const COHERE_TEXT_MODEL_IDS = ["cohere/command-a"] as const;
const PERPLEXITY_TEXT_MODEL_IDS = [
  "perplexity/sonar",
  "perplexity/sonar-pro",
  "perplexity/sonar-reasoning-pro",
] as const;
const INCEPTION_TEXT_MODEL_IDS = ["inception/mercury-2"] as const;
const MEITUAN_TEXT_MODEL_IDS = [
  "meituan/longcat-flash-chat",
  "meituan/longcat-flash-thinking-2601",
] as const;

function formatProviderLabel(provider: string): string {
  switch (normalizeProviderKey(provider)) {
    case "groq":
      return "Groq";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "xai":
      return "X.AI";
    case "mistral":
      return "Mistral";
    case "minimax":
      return "Minimax";
    case "deepseek":
      return "DeepSeek";
    case "zai":
      return "Z.AI (Zhipu)";
    case "moonshotai":
      return "Moonshot (Kimi)";
    case "bytedance":
      return "ByteDance (Seed)";
    case "amazon":
      return "Amazon (Nova)";
    case "cohere":
      return "Cohere";
    case "perplexity":
      return "Perplexity";
    case "inception":
      return "Inception";
    case "meituan":
      return "Meituan (LongCat)";
    default:
      return provider;
  }
}

function titleCase(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (part === "4o") return "4o";
      if (part === "o1") return "o1";
      if (part === "o3") return "o3";
      if (part === "o4") return "o4";
      if (/^\d+(\.\d+)?[a-z]*$/i.test(part)) {
        return part.toUpperCase();
      }
      if (part === "gpt") return "GPT";
      if (part === "codex") return "Codex";
      if (part === "oss") return "OSS";
      if (part === "claude") return "Claude";
      if (part === "gemini") return "Gemini";
      if (part === "flash") return "Flash";
      if (part === "lite") return "Lite";
      if (part === "mini") return "Mini";
      if (part === "nano") return "Nano";
      if (part === "pro") return "Pro";
      if (part === "instant") return "Instant";
      if (part === "thinking") return "Thinking";
      if (part === "deep") return "Deep";
      if (part === "research") return "Research";
      if (part === "search") return "Search";
      if (part === "preview") return "Preview";
      if (part === "sonnet") return "Sonnet";
      if (part === "opus") return "Opus";
      if (part === "haiku") return "Haiku";
      if (part === "chat") return "Chat";
      if (part === "compound") return "Compound";
      if (part === "grok") return "Grok";
      if (part === "mistral") return "Mistral";
      if (part === "minimax") return "Minimax";
      if (part === "abab6.5") return "abab6.5";
      if (part === "deepseek") return "DeepSeek";
      if (part === "glm") return "GLM";
      if (part === "kimi") return "Kimi";
      if (part === "sonar") return "Sonar";
      if (part === "command") return "Command";
      if (part === "nova") return "Nova";
      if (part === "mercury") return "Mercury";
      if (part === "longcat") return "LongCat";
      if (part === "codestral") return "Codestral";
      if (part === "devstral") return "Devstral";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function buildSelectorName(modelId: string): string {
  const [provider, rawName] = modelId.includes("/") ? modelId.split("/", 2) : ["", modelId];

  if (!rawName) {
    return modelId;
  }

  if (provider === "anthropic") {
    return titleCase(rawName.replace(/^claude-/, "claude-"));
  }

  return titleCase(rawName);
}

function buildSelectorDescription(modelId: string): string {
  const id = modelId.toLowerCase();

  if (id.includes("codex")) return "Coding-focused model";
  if (id.includes("deep-research")) return "Research-focused reasoning model";
  if (id.includes("thinking")) return "Extended reasoning model";
  if (id.includes("search-preview")) return "Search-specialized preview model";
  if (id.includes("opus")) return "Highest-capability Claude model";
  if (id.includes("sonnet")) return "Balanced Claude model";
  if (id.includes("haiku")) return "Fast Claude model";
  if (id.includes("flash-lite")) return "Lowest-latency Gemini option";
  if (id.includes("flash")) return "Fast general-purpose model";
  if (id.includes("pro")) return "Highest-capability option";
  if (id.includes("mini")) return "Faster, lower-cost option";
  if (id.includes("nano")) return "Smallest, lowest-cost option";
  if (id.includes("oss")) return "Open-weight reasoning model";
  if (/\/o[134]/.test(id) || id.endsWith("/o1")) return "Reasoning-focused model";
  if (id.includes("compound")) return "Groq compound system model";
  if (id.includes("4o")) return "General-purpose multimodal model";
  if (id.includes("4.1")) return "Reliable general-purpose model";
  if (id.includes("5")) return "Latest-generation reasoning model";
  return "General-purpose language model";
}

function buildCatalogModel(modelId: string): CatalogModel {
  const provider = modelId.split("/")[0] || "unknown";
  return {
    id: modelId,
    object: "model",
    created: 0,
    owned_by: provider,
    name: buildSelectorName(modelId),
    description: buildSelectorDescription(modelId),
    type: "language",
  };
}

function numericPricingValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isFreePricing(pricing?: Record<string, unknown>): boolean {
  if (!pricing) return false;

  const prompt = numericPricingValue(pricing.prompt);
  const completion = numericPricingValue(pricing.completion);
  const request = numericPricingValue(pricing.request);

  if (prompt === 0 && completion === 0) {
    return true;
  }

  return request === 0 && prompt == null && completion == null;
}

export function annotateCatalogModel(model: CatalogModel): CatalogModel {
  const recommended = model.recommended === true || OPENROUTER_RECOMMENDED_MODEL_IDS.has(model.id);
  const free = model.free === true || model.id.endsWith(":free") || isFreePricing(model.pricing);
  const tags = new Set(model.tags ?? []);

  if (recommended) tags.add("recommended");
  if (free) tags.add("free");

  return {
    ...model,
    ...(recommended ? { recommended: true } : {}),
    ...(free ? { free: true } : {}),
    ...(tags.size > 0 ? { tags: Array.from(tags) } : {}),
  };
}

export function annotateCatalogModels(models: CatalogModel[]): CatalogModel[] {
  return models.map(annotateCatalogModel);
}

export const GROQ_NATIVE_MODELS: CatalogModel[] = [
  {
    id: "groq/compound",
    object: "model",
    created: 0,
    owned_by: "groq",
    name: "Compound",
    description: "Groq compound system model",
    type: "language",
    tags: ["reasoning", "tool-use"],
  },
  {
    id: "groq/compound-mini",
    object: "model",
    created: 0,
    owned_by: "groq",
    name: "Compound Mini",
    description: "Smaller Groq compound system model",
    type: "language",
    tags: ["reasoning", "tool-use"],
  },
] as const;

export const GROQ_NATIVE_MODEL_ID_MAP: Record<string, string> = {
  "groq/compound": "compound-beta",
  "groq/compound-mini": "compound-beta-mini",
};

export const VAST_NATIVE_MODELS: CatalogModel[] = [
  // ─── eliza-1 series ────────────────────────────────────────────────
  // Self-hosted on Vast.ai. Manifests live in
  // cloud/services/vast-pyworker/manifests/eliza-1-*.json.
  {
    id: "vast/eliza-1-2b",
    object: "model",
    created: 0,
    owned_by: "vast",
    name: "Eliza-1 2B",
    description:
      "Eliza's smallest fine-tune (Q4_K_M GGUF, llama-server). Single GPU debug / latency-tolerant agent loops. HF: elizaos/eliza-1-2b-gguf-q4_k_m",
    type: "language",
    context_window: 32768,
    tags: ["self-hosted", "llama.cpp", "gguf", "eliza-eliza-1"],
  },
  {
    id: "vast/eliza-1-9b",
    object: "model",
    created: 0,
    owned_by: "vast",
    name: "Eliza-1 9B",
    description:
      "Workstation-tier Eliza fine-tune. Served via vLLM with PolarQuant + AWQ-Marlin and TurboQuant quality KV on 2× RTX PRO 6000 Blackwell. HF: elizaos/eliza-1-9b-polarquant",
    type: "language",
    context_window: 131072,
    tags: ["self-hosted", "vllm", "polarquant", "awq-marlin", "turboquant", "eliza-eliza-1"],
  },
  {
    id: "vast/eliza-1-27b",
    object: "model",
    created: 0,
    owned_by: "vast",
    name: "Eliza-1 27B",
    description:
      "Cloud-tier Eliza flagship. Served via vLLM with FP8 weights + TurboQuant quality KV on 2× H200 SXM. 4-bit KV is available as an explicit benchmark-gated runtime preset. HF: elizaos/eliza-1-27b-fp8",
    type: "language",
    context_window: 131072,
    tags: ["self-hosted", "vllm", "fp8", "turboquant", "eliza-eliza-1"],
  },
  {
    id: "vast/eliza-1-27b-256k",
    object: "model",
    created: 0,
    owned_by: "vast",
    name: "Eliza-1 27B 256K",
    description:
      "Single RTX 3090 long-context lane. Served via llama.cpp/GGUF with q4_0 KV cache, flash attention, one decode slot, and 262K context. DFlash remains benchmark-gated for this lane. HF: elizaos/eliza-1",
    type: "language",
    context_window: 262144,
    tags: ["self-hosted", "llama.cpp", "gguf", "q4-kv", "rtx-3090", "eliza-eliza-1"],
  },
] as const;

// llama-server's `--alias` flag makes the upstream model id match the catalog id,
// so this map intentionally has no translation entry. Kept in place so we can
// add quants/variants (e.g. a Q5_K_M for cheaper hosts) without restructuring.
export const VAST_NATIVE_MODEL_ID_MAP: Record<string, string> = {};

const STATIC_TEXT_MODEL_IDS = [
  ...OPENAI_TEXT_MODEL_IDS,
  ...ANTHROPIC_TEXT_MODEL_IDS,
  ...GOOGLE_TEXT_MODEL_IDS,
  ...XAI_TEXT_MODEL_IDS,
  ...MISTRAL_TEXT_MODEL_IDS,
  ...MINIMAX_TEXT_MODEL_IDS,
  ...DEEPSEEK_TEXT_MODEL_IDS,
  ...ZAI_TEXT_MODEL_IDS,
  ...MOONSHOT_TEXT_MODEL_IDS,
  ...BYTEDANCE_TEXT_MODEL_IDS,
  ...AMAZON_TEXT_MODEL_IDS,
  ...COHERE_TEXT_MODEL_IDS,
  ...PERPLEXITY_TEXT_MODEL_IDS,
  ...INCEPTION_TEXT_MODEL_IDS,
  ...MEITUAN_TEXT_MODEL_IDS,
  ...GROQ_NATIVE_MODELS.map((model) => model.id),
  ...VAST_NATIVE_MODELS.map((model) => model.id),
] as const;

export const STATIC_TEXT_CATALOG_MODELS: CatalogModel[] = annotateCatalogModels([
  ...OPENROUTER_FEATURED_TEXT_MODELS,
  ...STATIC_TEXT_MODEL_IDS.map(buildCatalogModel),
]);

export function isGroqNativeModel(modelId: string): boolean {
  return modelId in GROQ_NATIVE_MODEL_ID_MAP;
}

export function getGroqApiModelId(modelId: string): string {
  return GROQ_NATIVE_MODEL_ID_MAP[modelId] ?? modelId;
}

export function isVastNativeModel(modelId: string): boolean {
  return (
    modelId in VAST_NATIVE_MODEL_ID_MAP || VAST_NATIVE_MODELS.some((model) => model.id === modelId)
  );
}

export function getVastApiModelId(modelId: string): string {
  return VAST_NATIVE_MODEL_ID_MAP[modelId] ?? modelId;
}

export function mergeCatalogModels(
  baseModels: CatalogModel[],
  supplementalModels: CatalogModel[],
): CatalogModel[] {
  const merged = new Map<string, CatalogModel>();

  for (const model of baseModels) {
    merged.set(model.id, model);
  }

  for (const model of supplementalModels) {
    if (!merged.has(model.id)) {
      merged.set(model.id, model);
    }
  }

  return annotateCatalogModels(Array.from(merged.values()));
}

export function isSelectableTextModel(model: CatalogModel): boolean {
  if (model.type && model.type !== "language") {
    return false;
  }

  const outputs = model.architecture?.output_modalities?.map((value) => value.toLowerCase());
  const modality = model.architecture?.modality?.toLowerCase();
  if (
    outputs &&
    outputs.length > 0 &&
    !outputs.includes("text") &&
    !modality?.includes("text->text")
  ) {
    return false;
  }

  const modelId = model.id.toLowerCase();

  if (modelId === "openai/gpt-3.5-turbo-instruct") {
    return false;
  }

  if (
    modelId.includes("embedding") ||
    modelId.includes("guard") ||
    modelId.includes("safeguard") ||
    modelId.includes("imagen-") ||
    modelId.includes("veo-")
  ) {
    return false;
  }

  if (modelId.startsWith("google/") && modelId.includes("image")) {
    return false;
  }

  if (modelId.startsWith("openai/") && modelId.includes("image")) {
    return false;
  }

  return true;
}

function getProviderSortIndex(provider: string): number {
  switch (normalizeProviderKey(provider)) {
    case "groq":
      return 0;
    case "openai":
      return 1;
    case "anthropic":
      return 2;
    case "google":
      return 3;
    case "deepseek":
      return 4;
    case "xai":
      return 5;
    case "mistral":
      return 6;
    case "alibaba":
      return 7;
    case "minimax":
      return 8;
    case "zai":
      return 9;
    case "moonshotai":
      return 10;
    case "meta":
      return 11;
    case "bytedance":
      return 12;
    case "amazon":
      return 13;
    case "cohere":
      return 14;
    case "perplexity":
      return 15;
    case "inception":
      return 16;
    case "meituan":
      return 17;
    default:
      return 99;
  }
}

export function sortSelectorModels(models: SelectorModel[]): SelectorModel[] {
  return [...models].sort((a, b) => {
    const priorityDelta = getSelectorModelPriority(b) - getSelectorModelPriority(a);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const providerDelta = getProviderSortIndex(a.provider) - getProviderSortIndex(b.provider);
    if (providerDelta !== 0) {
      return providerDelta;
    }

    return a.name.localeCompare(b.name);
  });
}

function getSelectorModelPriority(model: SelectorModel): number {
  if (model.recommended) return 2;
  if (model.free) return 1;
  return 0;
}

export function toSelectorModel(model: CatalogModel): SelectorModel {
  return {
    id: model.id,
    modelId: model.id,
    provider: model.owned_by,
    name: model.name || buildSelectorName(model.id),
    description: model.description || buildSelectorDescription(model.id),
    ...(model.recommended ? { recommended: true } : {}),
    ...(model.free ? { free: true } : {}),
  };
}

export const FALLBACK_TEXT_SELECTOR_MODELS = sortSelectorModels(
  STATIC_TEXT_CATALOG_MODELS.filter(isSelectableTextModel).map(toSelectorModel),
);

export function getGroqCatalogModel(modelId: string): CatalogModel | null {
  return GROQ_NATIVE_MODELS.find((model) => model.id === modelId) ?? null;
}

/**
 * OpenRouter free model equivalents for fallback scenarios.
 * Maps gateway model IDs to OpenRouter free-tier models.
 */
export const OPENROUTER_FREE_MODEL_MAP: Record<string, string> = {
  [OPENROUTER_RECOMMENDED_TEXT_MODEL]: OPENROUTER_DEFAULT_FREE_MODEL,
  "openai/gpt-oss-120b": OPENROUTER_DEFAULT_FREE_MODEL,
  "openai/gpt-4o": OPENROUTER_DEFAULT_FREE_MODEL,
  "openai/gpt-5-mini": OPENROUTER_DEFAULT_FREE_MODEL,
  "openai/gpt-5.5": OPENROUTER_DEFAULT_FREE_MODEL,
  "anthropic/claude-sonnet-4.6": OPENROUTER_DEFAULT_FREE_MODEL,
  "anthropic/claude-sonnet-4-6": OPENROUTER_DEFAULT_FREE_MODEL,
  "google/gemini-2.0-flash": "google/gemini-2.0-flash-exp:free",
};

/**
 * Resolve a model ID to an OpenRouter free equivalent when falling back.
 */
export function getOpenRouterFreeModel(modelId: string): string {
  return OPENROUTER_FREE_MODEL_MAP[modelId] ?? OPENROUTER_DEFAULT_FREE_MODEL;
}

export function formatSelectorProvider(provider: string): string {
  return formatProviderLabel(provider);
}
