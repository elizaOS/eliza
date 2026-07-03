export type PricingProductFamily =
  | "language"
  | "embedding"
  | "image"
  | "video"
  | "music"
  | "sfx"
  | "tts"
  | "stt"
  | "voice_clone";

export type PricingBillingSource =
  | "gateway"
  | "bitrouter"
  | "atlascloud"
  | "groq"
  | "vast"
  | "cerebras"
  | "openai"
  | "anthropic"
  | "fal"
  | "elevenlabs"
  | "suno";

export type PricingChargeUnit =
  | "token"
  | "image"
  | "request"
  | "second"
  | "minute"
  | "hour"
  | "character"
  | "1k_requests";

/**
 * Cross-provider id aliases so pricing resolution still works for stored
 * agents, logs, and older clients sending legacy ids that no longer exist
 * in the current catalog.
 *
 * - Keys: canonical `provider/model` as callers still send it.
 * - Values: one or more current catalog ids to try (first hit wins).
 *
 * Reverse lookup is applied automatically so a request for the new id still
 * matches rows persisted under the old id until the next catalog refresh.
 */
export const PRICING_MODEL_ALIASES = {
  // Anthropic SDK ships -latest aliases that the cloud LLM gateway forwards
  // verbatim. Mirror them onto the canonical catalog ids so billing resolves.
  "anthropic/claude-3-5-haiku-latest": ["anthropic/claude-3.5-haiku"],
  "anthropic/claude-3-5-sonnet-latest": ["anthropic/claude-3.7-sonnet"],
  "anthropic/claude-3-7-sonnet-latest": ["anthropic/claude-3.7-sonnet"],
  "anthropic/claude-opus-4-latest": ["anthropic/claude-opus-4"],
  "anthropic/claude-sonnet-4-latest": ["anthropic/claude-sonnet-4"],
  "anthropic/claude-3.5-sonnet": ["anthropic/claude-3.7-sonnet"],
  "anthropic/claude-3.7-sonnet-reasoning": ["anthropic/claude-3.7-sonnet"],
  "anthropic/claude-4-opus": ["anthropic/claude-opus-4"],
  "anthropic/claude-4-opus-20250514": ["anthropic/claude-opus-4"],
  "anthropic/claude-4-sonnet": ["anthropic/claude-sonnet-4"],
  "anthropic/claude-4-sonnet-20250514": ["anthropic/claude-sonnet-4"],
  "anthropic/claude-v3-haiku": ["anthropic/claude-3-haiku"],
  "anthropic/claude-v3-opus": ["anthropic/claude-3-opus"],
  "anthropic/claude-v3.5-sonnet": ["anthropic/claude-3.7-sonnet"],
  "bedrock/amazon.nova-lite-v1:0": ["amazon/nova-lite"],
  "bedrock/amazon.nova-micro-v1:0": ["amazon/nova-micro"],
  "bedrock/amazon.nova-pro-v1:0": ["amazon/nova-pro"],
  "bedrock/claude-3-5-haiku-20241022": ["anthropic/claude-3.5-haiku"],
  "bedrock/claude-3-5-sonnet-20240620-v1": ["anthropic/claude-3.7-sonnet"],
  "bedrock/claude-3-5-sonnet-20241022-v2": ["anthropic/claude-3.7-sonnet"],
  "bedrock/claude-3-7-sonnet-20250219": ["anthropic/claude-3.7-sonnet"],
  "bedrock/claude-3-haiku-20240307-v1": ["anthropic/claude-3-haiku"],
  "bedrock/claude-4-opus-20250514-v1": ["anthropic/claude-opus-4"],
  "bedrock/claude-4-sonnet-20250514-v1": ["anthropic/claude-sonnet-4"],
  "bedrock/deepseek.r1-v1": ["deepseek/deepseek-r1"],
  "deepseek/deepseek-r1-0528": ["deepseek/deepseek-r1"],
  "fireworks/deepseek-r1": ["deepseek/deepseek-r1"],
  "fireworks/deepseek-v3": ["deepseek/deepseek-v3"],
  "fireworks/mixtral-8x22b-instruct": ["mistral/mixtral-8x22b-instruct"],
  "mistral/codestral-2501": ["mistral/codestral"],
  "mistral/ministral-3b-latest": ["mistral/ministral-3b"],
  "mistral/ministral-8b-latest": ["mistral/ministral-8b"],
  "mistral/mistral-small-2503": ["mistral/mistral-small"],
  "mistral/pixtral-12b-2409": ["mistral/pixtral-12b"],
  "mistral/pixtral-large-latest": ["mistral/pixtral-large"],
  "morph/morph-v2": ["morph/morph-v3-fast"],
  "vertex/claude-3-5-haiku-20241022": ["anthropic/claude-3.5-haiku"],
  "vertex/claude-3-5-sonnet-20240620": ["anthropic/claude-3.7-sonnet"],
  "vertex/claude-3-5-sonnet-v2-20241022": ["anthropic/claude-3.7-sonnet"],
  "vertex/claude-3-7-sonnet-20250219": ["anthropic/claude-3.7-sonnet"],
  "vertex/claude-3-haiku-20240307": ["anthropic/claude-3-haiku"],
  "vertex/claude-3-opus-20240229": ["anthropic/claude-3-opus"],
  "vertex/claude-4-opus-20250514": ["anthropic/claude-opus-4"],
  "vertex/claude-4-sonnet-20250514": ["anthropic/claude-sonnet-4"],
  "vertex/gemini-2.0-flash-001": ["google/gemini-2.0-flash"],
  "vertex/gemini-2.0-flash-lite-001": ["google/gemini-2.0-flash-lite"],
  "xai/grok-2-1212": ["xai/grok-3"],
  "xai/grok-2-vision-1212": ["xai/grok-3"],
  "xai/grok-2": ["xai/grok-3"],
  "xai/grok-2-vision": ["xai/grok-3"],
  "xai/grok-3-beta": ["xai/grok-3"],
  "xai/grok-3-fast-beta": ["xai/grok-3-fast"],
  "xai/grok-3-mini-beta": ["xai/grok-3-mini"],
  "xai/grok-3-mini-fast-beta": ["xai/grok-3-mini-fast"],
} as Readonly<Record<string, readonly string[]>>;

/** For each catalog target id, legacy ids that still resolve to it (O(1) reverse lookup). */
export function buildPricingLegacyIdsByTarget(
  forward: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const rev: Record<string, string[]> = {};
  for (const [legacyId, targets] of Object.entries(forward)) {
    for (const t of targets) {
      if (!rev[t]) rev[t] = [];
      rev[t].push(legacyId);
    }
  }
  return rev;
}

export const PRICING_LEGACY_IDS_BY_TARGET = buildPricingLegacyIdsByTarget(PRICING_MODEL_ALIASES);

export interface SupportedImageModelDefinition {
  modelId: string;
  provider: string;
  billingSource: PricingBillingSource;
  label: string;
  sourceUrl: string;
  defaultDimensions?: Record<string, string | number | boolean | null>;
  estimatedOutputTokens?: number;
}

export interface SupportedVideoModelDefinition {
  modelId: string;
  provider: "fal";
  billingSource: "fal";
  label: string;
  pageUrl: string;
  pricingParser:
    | "veo"
    | "veo31"
    | "veo31lite"
    | "kling"
    | "hailuo_standard"
    | "hailuo_pro"
    | "wan"
    | "pixverse"
    | "seedance";
  defaultParameters: {
    durationSeconds: number;
    resolution?: string;
    audio?: boolean;
    voiceControl?: boolean;
  };
}

export interface SupportedMusicModelDefinition {
  modelId: string;
  provider: "fal" | "elevenlabs" | "suno";
  billingSource: "fal" | "elevenlabs" | "suno";
  label: string;
  pageUrl: string;
  defaultParameters: {
    durationSeconds: number;
  };
}

export interface MusicSnapshotEntry {
  modelId: string;
  provider: "fal" | "elevenlabs" | "suno";
  billingSource: "fal" | "elevenlabs" | "suno";
  productFamily: "music";
  chargeType: string;
  unit: PricingChargeUnit;
  unitPrice: number;
  sourceUrl: string;
  dimensions?: Record<string, string | number | boolean | null>;
  metadata?: Record<string, unknown>;
}

export interface SupportedSfxModelDefinition {
  modelId: string;
  provider: "fal" | "elevenlabs";
  billingSource: "fal" | "elevenlabs";
  label: string;
  pageUrl: string;
  defaultParameters: {
    durationSeconds: number;
    maxDurationSeconds: number;
  };
}

export interface SfxSnapshotEntry {
  modelId: string;
  provider: "fal" | "elevenlabs";
  billingSource: "fal" | "elevenlabs";
  productFamily: "sfx";
  chargeType: string;
  unit: PricingChargeUnit;
  unitPrice: number;
  sourceUrl: string;
  dimensions?: Record<string, string | number | boolean | null>;
  metadata?: Record<string, unknown>;
}

export interface ElevenLabsSnapshotEntry {
  modelId: string;
  provider: "elevenlabs";
  billingSource: "elevenlabs";
  productFamily: Exclude<
    PricingProductFamily,
    "language" | "embedding" | "image" | "video" | "music"
  >;
  chargeType: string;
  unit: PricingChargeUnit;
  unitPrice: number;
  sourceUrl: string;
  dimensions?: Record<string, string | number | boolean | null>;
  metadata?: Record<string, unknown>;
}

// Every entry here MUST have an `image:generation` pricing row emitted by its
// billing source's catalog builder (atlascloud.ts / fal.ts). The former
// BitRouter image models (gemini-*-image*, gpt-5*-image*) were removed because
// BitRouter's pricing builder only emits token input/output rows — the image
// routes call calculateImageGenerationCostFromCatalog() BEFORE dispatch, so an
// unpriced model 500s "Pricing unavailable for image:generation" (#11005) —
// and BitRouter is no longer in the routing path.
export const SUPPORTED_IMAGE_MODELS: SupportedImageModelDefinition[] = [
  // Atlas Cloud image models. Atlas serves images via its async predict/poll
  // API (/api/v1/model/generateImage); model ids are task-suffixed
  // (e.g. "openai/gpt-image-2/text-to-image"). Native, un-marked-up provider
  // pricing.
  {
    modelId: "openai/gpt-image-2/text-to-image",
    provider: "openai",
    billingSource: "atlascloud",
    label: "GPT Image 2",
    sourceUrl: "https://www.atlascloud.ai/models/list",
    defaultDimensions: { size: "1024x1024", quality: "high" },
  },
  {
    modelId: "bytedance/seedream-v5.0-lite",
    provider: "bytedance",
    billingSource: "atlascloud",
    label: "Seedream 5.0 Lite",
    sourceUrl: "https://www.atlascloud.ai/models/list",
    defaultDimensions: { size: "default" },
  },
  {
    modelId: "google/nano-banana-2/text-to-image",
    provider: "google",
    billingSource: "atlascloud",
    label: "Nano Banana 2",
    sourceUrl: "https://www.atlascloud.ai/models/list",
    defaultDimensions: { size: "default" },
  },
  {
    modelId: "qwen/qwen-image-2.0/text-to-image",
    provider: "qwen",
    billingSource: "atlascloud",
    label: "Qwen Image 2.0",
    sourceUrl: "https://www.atlascloud.ai/models/list",
    defaultDimensions: { size: "default" },
  },
  {
    modelId: "fal-ai/flux/schnell",
    provider: "fal",
    billingSource: "fal",
    label: "FLUX.1 Schnell",
    sourceUrl: "https://fal.ai/models/fal-ai/flux/schnell",
    defaultDimensions: { image_size: "square_hd" },
  },
  {
    modelId: "fal-ai/flux/dev",
    provider: "fal",
    billingSource: "fal",
    label: "FLUX.1 Dev",
    sourceUrl: "https://fal.ai/models/fal-ai/flux/dev",
    defaultDimensions: { image_size: "square_hd" },
  },
  // Roster additions (#10688): design/vector + typography-strong image models
  // served through the existing fal image provider (same fal.run contract as
  // FLUX). Snapshot-priced in ai-pricing/providers/fal.ts.
  {
    modelId: "fal-ai/recraft/v3/text-to-image",
    provider: "fal",
    billingSource: "fal",
    label: "Recraft V3",
    sourceUrl: "https://fal.ai/models/fal-ai/recraft/v3/text-to-image",
    defaultDimensions: { image_size: "square_hd" },
  },
  {
    modelId: "fal-ai/ideogram/v3",
    provider: "fal",
    billingSource: "fal",
    label: "Ideogram V3",
    sourceUrl: "https://fal.ai/models/fal-ai/ideogram/v3",
    defaultDimensions: { image_size: "square_hd" },
  },
] as const;

/**
 * Canonical default image-generation model, used by /v1/generate-image,
 * /v1/apps/[id]/generate-image, the A2A image skill, promotion assets, and the
 * agent-runtime image setting. Nano Banana 2 (Google via Atlas Cloud) is the
 * closest analog to the retired BitRouter Gemini Flash Image default and has a
 * confirmed `image:generation` catalog row (see ai-pricing/providers/atlascloud.ts).
 */
export const DEFAULT_IMAGE_MODEL_ID = "google/nano-banana-2/text-to-image";

export const SUPPORTED_VIDEO_MODELS: SupportedVideoModelDefinition[] = [
  {
    modelId: "fal-ai/veo3",
    provider: "fal",
    billingSource: "fal",
    label: "Veo 3",
    pageUrl: "https://fal.ai/models/fal-ai/veo3",
    pricingParser: "veo",
    defaultParameters: {
      durationSeconds: 8,
      audio: true,
    },
  },
  {
    modelId: "fal-ai/veo3/fast",
    provider: "fal",
    billingSource: "fal",
    label: "Veo 3 Fast",
    pageUrl: "https://fal.ai/models/fal-ai/veo3/fast",
    pricingParser: "veo",
    defaultParameters: {
      durationSeconds: 8,
      audio: true,
    },
  },
  {
    modelId: "fal-ai/veo3.1",
    provider: "fal",
    billingSource: "fal",
    label: "Veo 3.1",
    pageUrl: "https://fal.ai/models/fal-ai/veo3.1",
    pricingParser: "veo31",
    defaultParameters: {
      durationSeconds: 8,
      resolution: "720p",
      audio: true,
    },
  },
  {
    modelId: "fal-ai/veo3.1/fast",
    provider: "fal",
    billingSource: "fal",
    label: "Veo 3.1 Fast",
    pageUrl: "https://fal.ai/models/fal-ai/veo3.1/fast",
    pricingParser: "veo31",
    defaultParameters: {
      durationSeconds: 8,
      resolution: "720p",
      audio: true,
    },
  },
  {
    modelId: "fal-ai/veo3.1/lite",
    provider: "fal",
    billingSource: "fal",
    label: "Veo 3.1 Lite",
    pageUrl: "https://fal.ai/models/fal-ai/veo3.1/lite",
    pricingParser: "veo31lite",
    defaultParameters: {
      durationSeconds: 8,
      resolution: "720p",
      audio: true,
    },
  },
  {
    modelId: "fal-ai/kling-video/v3/standard/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Kling 3 Standard",
    pageUrl: "https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video",
    pricingParser: "kling",
    defaultParameters: {
      durationSeconds: 5,
      audio: false,
      voiceControl: false,
    },
  },
  {
    modelId: "fal-ai/kling-video/v3/pro/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Kling 3 Pro",
    pageUrl: "https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video",
    pricingParser: "kling",
    defaultParameters: {
      durationSeconds: 5,
      audio: false,
      voiceControl: false,
    },
  },
  {
    modelId: "fal-ai/kling-video/v2.6/pro/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Kling 2.6 Pro",
    pageUrl: "https://fal.ai/models/fal-ai/kling-video/v2.6/pro/text-to-video",
    pricingParser: "kling",
    defaultParameters: {
      durationSeconds: 5,
      audio: false,
      voiceControl: false,
    },
  },
  {
    modelId: "fal-ai/minimax/hailuo-2.3/standard/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Hailuo 2.3 Standard",
    pageUrl: "https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video",
    pricingParser: "hailuo_standard",
    defaultParameters: {
      durationSeconds: 6,
    },
  },
  {
    modelId: "fal-ai/minimax/hailuo-2.3/pro/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Hailuo 2.3 Pro",
    pageUrl: "https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/text-to-video",
    pricingParser: "hailuo_pro",
    defaultParameters: {
      durationSeconds: 6,
    },
  },
  {
    modelId: "wan/v2.6/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Wan 2.6",
    pageUrl: "https://fal.ai/models/wan/v2.6/text-to-video",
    pricingParser: "wan",
    defaultParameters: {
      durationSeconds: 5,
      resolution: "720p",
    },
  },
  {
    modelId: "fal-ai/pixverse/v5/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "PixVerse 5",
    pageUrl: "https://fal.ai/models/fal-ai/pixverse/v5/text-to-video",
    pricingParser: "pixverse",
    defaultParameters: {
      durationSeconds: 5,
      resolution: "720p",
      audio: false,
    },
  },
  {
    modelId: "fal-ai/pixverse/v5.5/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "PixVerse 5.5",
    pageUrl: "https://fal.ai/models/fal-ai/pixverse/v5.5/text-to-video",
    pricingParser: "pixverse",
    defaultParameters: {
      durationSeconds: 5,
      resolution: "720p",
      audio: false,
    },
  },
  {
    modelId: "fal-ai/pixverse/v5.6/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "PixVerse 5.6",
    pageUrl: "https://fal.ai/models/fal-ai/pixverse/v5.6/text-to-video",
    pricingParser: "pixverse",
    defaultParameters: {
      durationSeconds: 5,
      resolution: "720p",
      audio: false,
    },
  },
  {
    modelId: "bytedance/seedance-2.0/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Seedance 2.0",
    pageUrl: "https://fal.ai/models/bytedance/seedance-2.0/text-to-video",
    pricingParser: "seedance",
    defaultParameters: {
      durationSeconds: 8,
      resolution: "720p",
      audio: true,
    },
  },
  {
    modelId: "bytedance/seedance-2.0/fast/text-to-video",
    provider: "fal",
    billingSource: "fal",
    label: "Seedance 2.0 Fast",
    pageUrl: "https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video",
    pricingParser: "seedance",
    defaultParameters: {
      durationSeconds: 8,
      resolution: "720p",
      audio: true,
    },
  },
] as const;

export const SUPPORTED_MUSIC_MODELS: SupportedMusicModelDefinition[] = [
  {
    modelId: "fal-ai/minimax-music/v2.6",
    provider: "fal",
    billingSource: "fal",
    label: "MiniMax Music 2.6",
    pageUrl: "https://fal.ai/models/fal-ai/minimax-music/v2.6/api",
    defaultParameters: {
      durationSeconds: 60,
    },
  },
  {
    modelId: "elevenlabs/music_v1",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    label: "ElevenLabs Music v1",
    pageUrl: "https://elevenlabs.io/docs/api-reference/music/compose",
    defaultParameters: {
      durationSeconds: 60,
    },
  },
  {
    modelId: "suno/default",
    provider: "suno",
    billingSource: "suno",
    label: "Suno-compatible provider",
    pageUrl: "https://docs.sunoapi.org/suno-api/generate-music/",
    defaultParameters: {
      durationSeconds: 120,
    },
  },
] as const;

export const SUPPORTED_SFX_MODELS: SupportedSfxModelDefinition[] = [
  {
    modelId: "elevenlabs/sound_effects_v1",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    label: "ElevenLabs Sound Effects",
    pageUrl: "https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert",
    defaultParameters: {
      durationSeconds: 5,
      maxDurationSeconds: 30,
    },
  },
  {
    modelId: "fal-ai/stable-audio-25/text-to-audio",
    provider: "fal",
    billingSource: "fal",
    label: "Stable Audio 2.5",
    pageUrl: "https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio",
    defaultParameters: {
      durationSeconds: 10,
      maxDurationSeconds: 190,
    },
  },
] as const;

export const SFX_SNAPSHOT_PRICING: SfxSnapshotEntry[] = [
  {
    modelId: "elevenlabs/sound_effects_v1",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "sfx",
    chargeType: "generation",
    unit: "request",
    unitPrice: 0.08,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "manual_override_recommended",
      note: "ElevenLabs sound effects bill in plan credits (~100 credits per generation); override with account-specific effective cost before production.",
    },
  },
  {
    modelId: "fal-ai/stable-audio-25/text-to-audio",
    provider: "fal",
    billingSource: "fal",
    productFamily: "sfx",
    chargeType: "generation",
    unit: "request",
    unitPrice: 0.2,
    sourceUrl: "https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio",
    metadata: {
      tier: "manual_override_recommended",
      note: "Fallback mirrors the current Fal model page price; override if account-specific Fal pricing differs.",
    },
  },
] as const;

export const MUSIC_SNAPSHOT_PRICING: MusicSnapshotEntry[] = [
  {
    modelId: "fal-ai/minimax-music/v2.6",
    provider: "fal",
    billingSource: "fal",
    productFamily: "music",
    chargeType: "generation",
    unit: "minute",
    unitPrice: 0.1,
    sourceUrl: "https://fal.ai/models/fal-ai/minimax-music/v2.6/api",
    metadata: {
      tier: "manual_override_recommended",
      note: "Conservative fallback for MiniMax music generation until account-specific Fal pricing is refreshed.",
    },
  },
  {
    modelId: "elevenlabs/music_v1",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "music",
    chargeType: "generation",
    unit: "minute",
    unitPrice: 0.25,
    sourceUrl: "https://elevenlabs.io/docs/api-reference/music/compose",
    metadata: {
      tier: "manual_override_recommended",
      note: "ElevenLabs Music uses plan/download limits; override with account-specific effective cost before production.",
    },
  },
  {
    modelId: "suno/default",
    provider: "suno",
    billingSource: "suno",
    productFamily: "music",
    chargeType: "generation",
    unit: "request",
    unitPrice: 0.5,
    sourceUrl: "https://docs.sunoapi.org/suno-api/generate-music/",
    metadata: {
      tier: "manual_override_required",
      note: "Suno-compatible provider pricing depends on the configured third-party provider.",
    },
  },
] as const;

export const ELEVENLABS_SNAPSHOT_PRICING: ElevenLabsSnapshotEntry[] = [
  {
    modelId: "elevenlabs/eleven_flash_v2_5",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "tts",
    chargeType: "generation",
    unit: "character",
    unitPrice: 0.00005,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "business_snapshot",
      note: "Published marginal API rate snapshot for Flash/Turbo-class models",
    },
  },
  {
    modelId: "elevenlabs/eleven_turbo_v2_5",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "tts",
    chargeType: "generation",
    unit: "character",
    unitPrice: 0.00005,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "business_snapshot",
      note: "Published marginal API rate snapshot for Flash/Turbo-class models",
    },
  },
  {
    modelId: "elevenlabs/eleven_multilingual_v2",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "tts",
    chargeType: "generation",
    unit: "character",
    unitPrice: 0.0001,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "business_snapshot",
      note: "Published marginal API rate snapshot for Multilingual-class models",
    },
  },
  {
    modelId: "elevenlabs/eleven_v3",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "tts",
    chargeType: "generation",
    unit: "character",
    unitPrice: 0.0001,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "business_snapshot",
      note: "Published marginal API rate snapshot for advanced multilingual models",
    },
  },
  {
    modelId: "elevenlabs/scribe_v1",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "stt",
    chargeType: "generation",
    unit: "hour",
    unitPrice: 0.22,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "business_snapshot",
      note: "Published marginal API rate snapshot for speech-to-text",
    },
  },
  {
    modelId: "elevenlabs/scribe_v2",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "stt",
    chargeType: "generation",
    unit: "hour",
    unitPrice: 0.22,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "business_snapshot",
      note: "Published marginal API rate snapshot for speech-to-text",
    },
  },
  {
    modelId: "elevenlabs/instant",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "voice_clone",
    chargeType: "generation",
    unit: "request",
    unitPrice: 0.42,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "manual_override_required",
      note: "Voice cloning does not expose a clean marginal API rate; override this if your account cost differs.",
    },
  },
  {
    modelId: "elevenlabs/professional",
    provider: "elevenlabs",
    billingSource: "elevenlabs",
    productFamily: "voice_clone",
    chargeType: "generation",
    unit: "request",
    unitPrice: 1.67,
    sourceUrl: "https://elevenlabs.io/pricing/api",
    metadata: {
      tier: "manual_override_required",
      note: "Voice cloning does not expose a clean marginal API rate; override this if your account cost differs.",
    },
  },
] as const;

export const SUPPORTED_VIDEO_MODEL_IDS = SUPPORTED_VIDEO_MODELS.map((model) => model.modelId);
export const SUPPORTED_IMAGE_MODEL_IDS = SUPPORTED_IMAGE_MODELS.map((model) => model.modelId);
export const SUPPORTED_MUSIC_MODEL_IDS = SUPPORTED_MUSIC_MODELS.map((model) => model.modelId);
export const SUPPORTED_SFX_MODEL_IDS = SUPPORTED_SFX_MODELS.map((model) => model.modelId);

export function getSupportedVideoModelDefinition(modelId: string) {
  return SUPPORTED_VIDEO_MODELS.find((model) => model.modelId === modelId);
}

export function getSupportedImageModelDefinition(modelId: string) {
  return SUPPORTED_IMAGE_MODELS.find((model) => model.modelId === modelId);
}

export function getSupportedMusicModelDefinition(modelId: string) {
  return SUPPORTED_MUSIC_MODELS.find((model) => model.modelId === modelId);
}

export function getSupportedSfxModelDefinition(modelId: string) {
  return SUPPORTED_SFX_MODELS.find((model) => model.modelId === modelId);
}
