/**
 * Canonical MODEL_TIER registry for the LifeOpsBench / prompt-optimization
 * pipeline.
 *
 * Tiers:
 * - `small`     — Qwen 0.8B GGUF via the dflash local-llama-cpp fork
 *                 (`~/.cache/eliza-dflash/eliza-llama-cpp`) or Ollama as
 *                 fallback. Tier-A smoke lane.
 * - `mid`       — Qwen 2B GGUF via the same fork. Tier-B manual /
 *                 scheduled.
 * - `large`     — Cerebras `gpt-oss-120b`. Default evaluation provider.
 * - `frontier`  — Anthropic Opus 4.7. Production runtime.
 *
 * The `resolveTier` helper reads `MODEL_TIER` plus three overrides
 * (`MODEL_NAME_OVERRIDE`, `MODEL_BASE_URL_OVERRIDE`, `MODEL_BUNDLE_OVERRIDE`)
 * so an operator can pin a specific quant / endpoint without editing source.
 */

export type ModelTier = "small" | "mid" | "large" | "frontier";

export type ModelTierProvider =
  | "cerebras"
  | "anthropic"
  | "openai"
  | "local-llama-cpp"
  | "ollama";

export interface TierSpec {
  tier: ModelTier;
  provider: ModelTierProvider;
  modelName: string;
  baseUrl?: string;
  /** Absolute or `~`-prefixed path to a GGUF bundle for local-inference tiers. */
  bundlePath?: string;
  contextWindow: number;
  notes?: string;
}

export const DEFAULT_TIERS: Record<ModelTier, TierSpec> = {
  small: {
    tier: "small",
    provider: "local-llama-cpp",
    modelName: "qwen3-0.8b-q8_0",
    bundlePath: "~/.eliza/local-inference/models/eliza-1-0.8b.bundle",
    contextWindow: 32_768,
    notes: "Tier-A smoke lane; dflash fork or Ollama fallback",
  },
  mid: {
    tier: "mid",
    provider: "local-llama-cpp",
    modelName: "qwen3-2b-q4_k_m",
    bundlePath: "~/.eliza/local-inference/models/eliza-1-2b.bundle",
    contextWindow: 65_536,
    notes: "Tier-B manual/scheduled",
  },
  large: {
    tier: "large",
    provider: "cerebras",
    modelName: "gpt-oss-120b",
    baseUrl: "https://api.cerebras.ai/v1",
    contextWindow: 131_072,
    notes: "Default eval provider; prompt caching enabled",
  },
  frontier: {
    tier: "frontier",
    provider: "anthropic",
    modelName: "claude-opus-4-7",
    contextWindow: 200_000,
    notes: "Production runtime",
  },
};

const VALID_TIERS = new Set<ModelTier>(["small", "mid", "large", "frontier"]);

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && VALID_TIERS.has(value as ModelTier);
}

/**
 * Resolve a TierSpec from the environment. Reads `MODEL_TIER`
 * (defaults to `large`) and applies the three single-field overrides if set.
 *
 * Returns a fresh copy of the registry entry — callers may mutate the
 * returned spec without affecting `DEFAULT_TIERS`.
 */
export function resolveTier(env: NodeJS.ProcessEnv = process.env): TierSpec {
  const raw = env.MODEL_TIER?.trim();
  const tier: ModelTier = raw && isModelTier(raw) ? raw : "large";

  const spec: TierSpec = { ...DEFAULT_TIERS[tier] };

  const nameOverride = env.MODEL_NAME_OVERRIDE?.trim();
  if (nameOverride) {
    spec.modelName = nameOverride;
  }
  const baseUrlOverride = env.MODEL_BASE_URL_OVERRIDE?.trim();
  if (baseUrlOverride) {
    spec.baseUrl = baseUrlOverride;
  }
  const bundleOverride = env.MODEL_BUNDLE_OVERRIDE?.trim();
  if (bundleOverride) {
    spec.bundlePath = bundleOverride;
  }

  return spec;
}
