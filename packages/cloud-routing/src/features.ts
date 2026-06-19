export const FEATURE_POLICIES = ["local", "cloud", "auto"] as const;
export type FeaturePolicy = (typeof FEATURE_POLICIES)[number];

export const DEFAULT_FEATURE_POLICY: FeaturePolicy = "auto";

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

export const FEATURE_IDS = FEATURES.map((f) => f.id) as ReadonlyArray<Feature>;

const FEATURE_BY_ID: ReadonlyMap<Feature, (typeof FEATURES)[number]> = new Map(
  FEATURES.map((f) => [f.id, f]),
);

export function getFeature(id: string): (typeof FEATURES)[number] | null {
  return FEATURE_BY_ID.get(id as Feature) ?? null;
}

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && FEATURE_BY_ID.has(value as Feature);
}

const FEATURE_POLICY_SET: ReadonlySet<string> = new Set(FEATURE_POLICIES);

export function isFeaturePolicy(value: unknown): value is FeaturePolicy {
  return typeof value === "string" && FEATURE_POLICY_SET.has(value);
}

export type FeaturePolicyMap = Readonly<Record<Feature, FeaturePolicy>>;
