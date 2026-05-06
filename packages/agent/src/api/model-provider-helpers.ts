/**
 * Model and provider discovery helpers.
 *
 * Extracted from server.ts. Handles model listing, provider caching,
 * and inventory (chain/RPC) option resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import {
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "@elizaos/shared";
import { resolveModelsCacheDir } from "../config/paths.js";

type ModelOption = {
  id: string;
  name: string;
  provider: string;
  description: string;
  recommended?: boolean;
  free?: boolean;
};

export function getModelOptions(): {
  nano: ModelOption[];
  small: ModelOption[];
  medium: ModelOption[];
  large: ModelOption[];
  mega: ModelOption[];
} {
  // All models available via Eliza Cloud (Vercel AI Gateway).
  // IDs use "provider/model" format to match the cloud API routing.
  // Every tier exposes the full catalog so users can assign any model to any slot.
  const allModels = [
    {
      id: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
      name: "GPT OSS 120B Nitro",
      provider: "OpenAI",
      description: "Recommended OpenRouter high-throughput reasoning model.",
      recommended: true,
    },
    {
      id: DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
      name: "GPT OSS 120B Free",
      provider: "OpenAI",
      description: "Free OpenRouter reasoning model.",
      free: true,
    },
    // Anthropic
    {
      id: "anthropic/claude-opus-4.7",
      name: "Claude Opus 4.7",
      provider: "Anthropic",
      description: "Most capable Claude model.",
    },
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      provider: "Anthropic",
      description: "Strong planning and reasoning.",
    },
    {
      id: "anthropic/claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      provider: "Anthropic",
      description: "Fast Claude for lightweight tasks.",
    },
    // OpenAI
    {
      id: "openai/gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      provider: "OpenAI",
      description: "Highest-precision GPT-5.5 variant.",
    },
    {
      id: "openai/gpt-5.5",
      name: "GPT-5.5",
      provider: "OpenAI",
      description: "Flagship OpenAI model for coding and reasoning.",
    },
    {
      id: "openai/gpt-5-mini",
      name: "GPT-5.5 Mini",
      provider: "OpenAI",
      description: "High-volume OpenAI mini model.",
    },
    {
      id: "openai/gpt-5.5-nano",
      name: "GPT-5.5 Nano",
      provider: "OpenAI",
      description: "Cheapest GPT-5.5 tier for fast routing and gating.",
    },
    // Google
    {
      id: "google/gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      provider: "Google",
      description: "Most capable Gemini. 1M context, advanced reasoning.",
    },
    {
      id: "google/gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      provider: "Google",
      description: "Stable multimodal reasoning.",
    },
    {
      id: "google/gemini-3-flash",
      name: "Gemini 3 Flash",
      provider: "Google",
      description: "Fast next-gen Gemini.",
    },
    {
      id: "google/gemini-3.1-flash-lite-preview",
      name: "Gemini 3.1 Flash Lite Preview",
      provider: "Google",
      description: "Fastest Gemini tier.",
    },
    // DeepSeek
    {
      id: "deepseek/deepseek-r1",
      name: "DeepSeek R1",
      provider: "DeepSeek",
      description: "Reasoning model.",
    },
    {
      id: "deepseek/deepseek-v3.2",
      name: "DeepSeek V3.2",
      provider: "DeepSeek",
      description: "Open and powerful.",
    },
    // Moonshot
    {
      id: "moonshotai/kimi-k2.5",
      name: "Kimi K2.5",
      provider: "Moonshot",
      description: "Multimodal agentic model from Moonshot AI.",
    },
    // Z.AI
    {
      id: "zai/glm-5.1",
      name: "GLM 5.1",
      provider: "Z.AI",
      description: "Latest GLM reasoning model.",
    },
    // MiniMax
    {
      id: "minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      provider: "MiniMax",
      description: "Fast reasoning with strong value.",
    },
    {
      id: "minimax/minimax-m2.5-lightning",
      name: "MiniMax M2.5 Lightning",
      provider: "MiniMax",
      description: "Lowest-latency MiniMax option.",
    },
    // Groq
    {
      id: "groq/llama-4-scout",
      name: "Llama 4 Scout",
      provider: "Groq",
      description: "Latest Llama on Groq inference.",
    },
    {
      id: "groq/llama-3.3-70b",
      name: "Llama 3.3 70B",
      provider: "Groq",
      description: "Strong open-weight model on Groq.",
    },
    {
      id: "groq/llama-3.1-8b-instant",
      name: "Llama 3.1 8B Instant",
      provider: "Groq",
      description: "Low-latency Groq nano option.",
    },
  ];

  return {
    nano: allModels,
    small: allModels,
    medium: allModels,
    large: allModels,
    mega: allModels,
  };
}

// ---------------------------------------------------------------------------
// Dynamic model catalog — per-provider cache, fetch, and serve model lists
// ---------------------------------------------------------------------------

export type ModelCategory =
  | "chat"
  | "embedding"
  | "image"
  | "tts"
  | "stt"
  | "other";

export interface CachedModel {
  id: string;
  name: string;
  category: ModelCategory;
}

export interface ProviderCache {
  version: 1;
  providerId: string;
  fetchedAt: string;
  models: CachedModel[];
}

export function classifyModel(modelId: string): ModelCategory {
  const id = modelId.toLowerCase();
  if (id.includes("embed") || id.includes("text-embedding")) return "embedding";
  if (
    id.includes("dall-e") ||
    id.includes("dalle") ||
    id.includes("imagen") ||
    id.includes("stable-diffusion") ||
    id.includes("midjourney") ||
    id.includes("flux")
  )
    return "image";
  if (
    id.includes("tts") ||
    id.includes("text-to-speech") ||
    id.includes("eleven_")
  )
    return "tts";
  if (id.includes("whisper") || id.includes("stt") || id.includes("transcrib"))
    return "stt";
  if (
    id.includes("moderation") ||
    id.includes("guard") ||
    id.includes("safety")
  )
    return "other";
  return "chat";
}

/** Map param key → expected model category */
export function paramKeyToCategory(paramKey: string): ModelCategory {
  const k = paramKey.toUpperCase();
  if (k.includes("EMBEDDING")) return "embedding";
  if (k.includes("IMAGE")) return "image";
  if (k.includes("TTS")) return "tts";
  if (k.includes("STT") || k.includes("TRANSCRIPTION")) return "stt";
  return "chat";
}

const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PROVIDER_ENV_KEYS: Record<
  string,
  { envKey: string; altEnvKeys?: string[]; baseUrl?: string }
> = {
  anthropic: { envKey: "ANTHROPIC_API_KEY" },
  openai: { envKey: "OPENAI_API_KEY" },
  groq: { envKey: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1" },
  xai: { envKey: "XAI_API_KEY", baseUrl: "https://api.x.ai/v1" },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  deepseek: {
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
  },
  zai: {
    envKey: "ZAI_API_KEY",
    altEnvKeys: ["Z_AI_API_KEY"],
    baseUrl: "https://api.z.ai/api/paas/v4",
  },
  moonshot: {
    envKey: "MOONSHOT_API_KEY",
    altEnvKeys: ["KIMI_API_KEY"],
    baseUrl: "https://api.moonshot.ai/v1",
  },
  "google-genai": {
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    altEnvKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  },
  ollama: { envKey: "OLLAMA_BASE_URL" },
  "vercel-ai-gateway": {
    envKey: "AI_GATEWAY_API_KEY",
    altEnvKeys: ["AIGATEWAY_API_KEY"],
  },
};

// ── Per-provider cache read/write ────────────────────────────────────────

export function providerCachePath(providerId: string): string {
  return path.join(resolveModelsCacheDir(), `${providerId}.json`);
}

export function readProviderCache(providerId: string): ProviderCache | null {
  try {
    const raw = fs.readFileSync(providerCachePath(providerId), "utf-8");
    const cache = JSON.parse(raw) as ProviderCache;
    if (cache.version !== 1 || !cache.fetchedAt || !cache.models) return null;
    const age = Date.now() - new Date(cache.fetchedAt).getTime();
    if (age > MODELS_CACHE_TTL_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

export function writeProviderCache(cache: ProviderCache): void {
  try {
    const dir = resolveModelsCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      providerCachePath(cache.providerId),
      JSON.stringify(cache, null, 2),
    );
  } catch (e: unknown) {
    logger.warn(
      `[model-catalog] Failed to write cache for ${cache.providerId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

// ── Provider fetchers ────────────────────────────────────────────────────

/** Fetch models from unknown provider's /v1/models endpoint (standard REST). */
export async function fetchModelsREST(
  providerId: string,
  apiKey: string,
  baseUrl: string,
): Promise<CachedModel[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string; type?: string }>;
    };
    return (data.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        category: m.type ? restTypeToCategory(m.type) : classifyModel(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e: unknown) {
    logger.warn(
      `[model-catalog] Failed to fetch models for ${providerId}: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

export function restTypeToCategory(type: string): ModelCategory {
  const t = type.toLowerCase();
  if (t.includes("embed")) return "embedding";
  if (t === "image" || t.includes("image-generation")) return "image";
  if (t.includes("tts") || t.includes("speech")) return "tts";
  if (t.includes("stt") || t.includes("transcription") || t.includes("whisper"))
    return "stt";
  if (t === "language" || t === "chat" || t.includes("text")) return "chat";
  return classifyModel(type);
}

export async function fetchAnthropicModels(
  apiKey: string,
): Promise<CachedModel[]> {
  try {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string; type?: string }>;
    };
    return (data.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.display_name ?? m.id,
        category: classifyModel(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e: unknown) {
    logger.warn(
      `[model-catalog] Failed to fetch Anthropic models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

export async function fetchGoogleModels(
  apiKey: string,
): Promise<CachedModel[]> {
  try {
    const url = apiKey
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      : "https://generativelanguage.googleapis.com/v1beta/models";
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name: string; displayName?: string }>;
    };
    return (data.models ?? []).map((m) => {
      const id = m.name.replace("models/", "");
      return {
        id,
        name: m.displayName ?? id,
        category: classifyModel(id),
      };
    });
  } catch (e: unknown) {
    logger.warn(
      `[model-catalog] Failed to fetch Google models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

export async function fetchOllamaModels(
  baseUrl: string,
): Promise<CachedModel[]> {
  try {
    let urlStr = baseUrl.replace(/\/+$/, "");
    if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
      urlStr = `http://${urlStr}`;
    }
    // @duplicate-component-audit-allow: Ollama tags is a model catalog lookup, not generation.
    const res = await fetch(`${urlStr}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      category: classifyModel(m.name),
    }));
  } catch (e: unknown) {
    logger.warn(
      `[model-catalog] Failed to fetch Ollama models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

/** Fetch ALL OpenRouter models: chat (/api/v1/models) + embeddings (/api/v1/embeddings/models). */
export async function fetchOpenRouterModels(
  apiKey: string,
): Promise<CachedModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  interface ORModel {
    id: string;
    name?: string;
    architecture?: { modality?: string; output_modalities?: string[] };
  }

  // Fetch chat/text models and embedding models in parallel
  const [chatRes, embedRes] = await Promise.all([
    fetch("https://openrouter.ai/api/v1/models?output_modalities=all", {
      headers,
    }).catch(() => null),
    fetch("https://openrouter.ai/api/v1/embeddings/models", { headers }).catch(
      () => null,
    ),
  ]);

  const models: CachedModel[] = [];

  // Parse chat/text/image models
  if (chatRes?.ok) {
    try {
      const data = (await chatRes.json()) as { data?: ORModel[] };
      for (const m of data.data ?? []) {
        const outputs = (m.architecture?.output_modalities ?? []).map((value) =>
          value.toLowerCase(),
        );
        const modality = m.architecture?.modality?.toLowerCase() ?? "";
        let category: ModelCategory = "chat";
        if (outputs.includes("text") || modality.includes("text->text")) {
          category = "chat";
        } else if (outputs.includes("image")) category = "image";
        else if (outputs.includes("audio")) category = "tts";
        models.push({ id: m.id, name: m.name ?? m.id, category });
      }
    } catch {
      /* parse error */
    }
  }

  // Parse embedding models
  if (embedRes?.ok) {
    try {
      const data = (await embedRes.json()) as { data?: ORModel[] };
      for (const m of data.data ?? []) {
        models.push({ id: m.id, name: m.name ?? m.id, category: "embedding" });
      }
    } catch {
      /* parse error */
    }
  }

  const deduped = Array.from(
    new Map(models.map((model) => [model.id, model])).values(),
  );
  deduped.sort((a, b) => a.id.localeCompare(b.id));
  return deduped;
}

/** Fetch Vercel AI Gateway models, whose REST catalog uses bearer auth. */
export async function fetchVercelGatewayModels(
  baseUrl: string,
  apiKey?: string,
): Promise<CachedModel[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string; type?: string }>;
    };
    return (data.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        category: m.type ? restTypeToCategory(m.type) : classifyModel(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e: unknown) {
    logger.warn(
      `[model-catalog] Failed to fetch Vercel AI Gateway models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

export async function fetchProviderModels(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<CachedModel[]> {
  switch (providerId) {
    case "anthropic":
      return fetchAnthropicModels(apiKey);
    case "google-genai":
      return fetchGoogleModels(apiKey);
    case "ollama":
      return fetchOllamaModels(baseUrl || "http://localhost:11434");
    case "openrouter":
      return fetchOpenRouterModels(apiKey);
    case "openai":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.openai.com/v1",
      );
    case "groq":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.groq.com/openai/v1",
      );
    case "xai":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.x.ai/v1",
      );
    case "deepseek":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.deepseek.com",
      );
    case "zai":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.z.ai/api/paas/v4",
      );
    case "moonshot":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.moonshot.ai/v1",
      );
    case "vercel-ai-gateway":
      return fetchVercelGatewayModels(
        baseUrl ?? "https://ai-gateway.vercel.sh/v1",
        apiKey,
      );
    default:
      return [];
  }
}

/** Fetch + cache a single provider. Returns cached models or empty array. */
export async function getOrFetchProvider(
  providerId: string,
  force = false,
): Promise<CachedModel[]> {
  if (!force) {
    const cached = readProviderCache(providerId);
    if (cached) return cached.models;
  }

  const cfg = PROVIDER_ENV_KEYS[providerId];
  if (!cfg) return [];

  let keyValue = process.env[cfg.envKey]?.trim();
  if (!keyValue && cfg.altEnvKeys) {
    for (const alt of cfg.altEnvKeys) {
      keyValue = process.env[alt]?.trim();
      if (keyValue) break;
    }
  }

  let baseUrl = cfg.baseUrl;
  if (providerId === "vercel-ai-gateway") {
    baseUrl =
      process.env.AI_GATEWAY_BASE_URL?.trim() ||
      "https://ai-gateway.vercel.sh/v1";
  }

  // Skip remote providers that need an API key when none is configured
  const keylessProviders = new Set([
    "ollama",
    "openrouter",
    "vercel-ai-gateway",
  ]);
  if (!keyValue && !keylessProviders.has(providerId)) return [];

  const models = await fetchProviderModels(providerId, keyValue ?? "", baseUrl);
  if (models.length > 0) {
    writeProviderCache({
      version: 1,
      providerId,
      fetchedAt: new Date().toISOString(),
      models,
    });
  }
  return models;
}

/** Fetch all configured providers (parallel). Returns map of providerId → models. */
export async function getOrFetchAllProviders(
  force = false,
): Promise<Record<string, CachedModel[]>> {
  const result: Record<string, CachedModel[]> = {};
  const fetches: Array<Promise<void>> = [];

  for (const providerId of Object.keys(PROVIDER_ENV_KEYS)) {
    fetches.push(
      getOrFetchProvider(providerId, force).then((models) => {
        if (models.length > 0) result[providerId] = models;
      }),
    );
  }

  await Promise.all(fetches);
  return result;
}

export function getInventoryProviderOptions(): Array<{
  id: string;
  name: string;
  description: string;
  rpcProviders: Array<{
    id: string;
    name: string;
    description: string;
    envKey: string | null;
    requiresKey: boolean;
  }>;
}> {
  return [
    {
      id: "evm",
      name: "EVM",
      description: "Ethereum, Base, Arbitrum, Optimism, Polygon.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "infura",
          name: "Infura",
          description: "Reliable EVM infrastructure.",
          envKey: "INFURA_API_KEY",
          requiresKey: true,
        },
        {
          id: "alchemy",
          name: "Alchemy",
          description: "Full-featured EVM data platform.",
          envKey: "ALCHEMY_API_KEY",
          requiresKey: true,
        },
        {
          id: "ankr",
          name: "Ankr",
          description: "Decentralized RPC provider.",
          envKey: "ANKR_API_KEY",
          requiresKey: true,
        },
      ],
    },
    {
      id: "bsc",
      name: "BSC",
      description: "BNB Smart Chain tokens, NFTs, and trades.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "alchemy",
          name: "Alchemy",
          description: "Managed BSC RPC via Alchemy.",
          envKey: "ALCHEMY_API_KEY",
          requiresKey: true,
        },
        {
          id: "ankr",
          name: "Ankr",
          description: "Decentralized BSC RPC provider.",
          envKey: "ANKR_API_KEY",
          requiresKey: true,
        },
        {
          id: "nodereal",
          name: "NodeReal",
          description: "Dedicated BSC RPC endpoint.",
          envKey: "NODEREAL_BSC_RPC_URL",
          requiresKey: true,
        },
        {
          id: "quicknode",
          name: "QuickNode",
          description: "Managed BSC RPC endpoint.",
          envKey: "QUICKNODE_BSC_RPC_URL",
          requiresKey: true,
        },
      ],
    },
    {
      id: "solana",
      name: "Solana",
      description: "Solana mainnet tokens and NFTs.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "helius-birdeye",
          name: "Helius + Birdeye",
          description: "Solana balances and NFT metadata.",
          envKey: "HELIUS_API_KEY",
          requiresKey: true,
        },
      ],
    },
  ];
}
