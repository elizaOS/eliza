export declare const FEATURE_POLICIES: readonly ["local", "cloud", "auto"];
export type FeaturePolicy = (typeof FEATURE_POLICIES)[number];
export declare const DEFAULT_FEATURE_POLICY: FeaturePolicy;
export declare const FEATURES: readonly [
  {
    readonly id: "llm";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_LLM";
    readonly description: "Text and multimodal language model calls.";
  },
  {
    readonly id: "rpc";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_RPC";
    readonly description: "Blockchain RPC reads and writes.";
  },
  {
    readonly id: "tool_use";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_TOOL_USE";
    readonly description: "Tool/function execution (search, browser, code, etc.).";
  },
  {
    readonly id: "embeddings";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_EMBEDDINGS";
    readonly description: "Vector embeddings for memory and retrieval.";
  },
  {
    readonly id: "media";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_MEDIA";
    readonly description: "Image, audio, and video generation/processing.";
  },
  {
    readonly id: "tts";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_TTS";
    readonly description: "Text-to-speech synthesis.";
  },
  {
    readonly id: "stt";
    readonly settingKey: "ELIZAOS_CLOUD_ROUTING_STT";
    readonly description: "Speech-to-text transcription.";
  },
];
export type Feature = (typeof FEATURES)[number]["id"];
export declare const FEATURE_IDS: ReadonlyArray<Feature>;
export declare function getFeature(
  id: string,
): (typeof FEATURES)[number] | null;
export declare function isFeature(value: unknown): value is Feature;
export declare function isFeaturePolicy(value: unknown): value is FeaturePolicy;
export type FeaturePolicyMap = Readonly<Record<Feature, FeaturePolicy>>;
