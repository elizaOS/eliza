/**
 * Canonical per-feature cloud-routing registry.
 *
 * Per-feature hybrid routing lets a user pin individual capabilities
 * ("llm goes through Eliza Cloud, rpc stays local, tool_use is auto…")
 * without forcing the whole agent into a single mode. The registry is
 * the single source of truth for which feature ids exist; all
 * resolution code consults this list instead of switching on string
 * literals (no `if (feature === "llm")` branching anywhere).
 *
 * Each feature has:
 *   - `id`           — the canonical key persisted in settings.
 *   - `settingKey`   — runtime setting name that holds the
 *                      per-feature policy (`local` | `cloud` | `auto`).
 *   - `description`  — short, durable explanation surfaced in the UI.
 *
 * To add a new feature: append a single entry to `FEATURES`. The type
 * `Feature` and the `FEATURE_IDS` constant pick it up automatically.
 */

export const FEATURE_POLICIES = ["local", "cloud", "auto"] as const;
export type FeaturePolicy = (typeof FEATURE_POLICIES)[number];

export const DEFAULT_FEATURE_POLICY: FeaturePolicy = "auto";

/**
 * The canonical feature registry. Every entry contributes one row to
 * the per-feature routing panel and one persisted setting key.
 */
export const FEATURES = [
  {
    id: "llm",
    settingKey: "ELIZAOS_CLOUD_ROUTING_LLM",
    description: "Text and multimodal language model calls.",
  },
  {
    id: "rpc",
    settingKey: "ELIZAOS_CLOUD_ROUTING_RPC",
    description: "Blockchain RPC reads and writes.",
  },
  {
    id: "tool_use",
    settingKey: "ELIZAOS_CLOUD_ROUTING_TOOL_USE",
    description: "Tool/function execution (search, browser, code, etc.).",
  },
  {
    id: "embeddings",
    settingKey: "ELIZAOS_CLOUD_ROUTING_EMBEDDINGS",
    description: "Vector embeddings for memory and retrieval.",
  },
  {
    id: "media",
    settingKey: "ELIZAOS_CLOUD_ROUTING_MEDIA",
    description: "Image, audio, and video generation/processing.",
  },
  {
    id: "tts",
    settingKey: "ELIZAOS_CLOUD_ROUTING_TTS",
    description: "Text-to-speech synthesis.",
  },
  {
    id: "stt",
    settingKey: "ELIZAOS_CLOUD_ROUTING_STT",
    description: "Speech-to-text transcription.",
  },
] as const satisfies readonly FeatureDefinition[];

interface FeatureDefinition {
  readonly id: string;
  readonly settingKey: string;
  readonly description: string;
}

export type Feature = (typeof FEATURES)[number]["id"];

/** All feature ids as a typed tuple, in declaration order. */
export const FEATURE_IDS = FEATURES.map((f) => f.id) as ReadonlyArray<Feature>;

const FEATURE_BY_ID: ReadonlyMap<Feature, (typeof FEATURES)[number]> = new Map(
  FEATURES.map((f) => [f.id, f]),
);

/** Look up a feature definition by id. Returns `null` for unknown ids. */
export function getFeature(id: string): (typeof FEATURES)[number] | null {
  return FEATURE_BY_ID.get(id as Feature) ?? null;
}

/** Type guard: `value` is a registered feature id. */
export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && FEATURE_BY_ID.has(value as Feature);
}

/** Type guard: `value` is a valid `FeaturePolicy`. */
export function isFeaturePolicy(value: unknown): value is FeaturePolicy {
  return value === "local" || value === "cloud" || value === "auto";
}

/** A complete, required policy map keyed by every feature id. */
export type FeaturePolicyMap = Readonly<Record<Feature, FeaturePolicy>>;
