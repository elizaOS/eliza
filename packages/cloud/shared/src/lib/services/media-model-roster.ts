import {
  SUPPORTED_IMAGE_MODEL_IDS,
  SUPPORTED_MUSIC_MODEL_IDS,
  SUPPORTED_SFX_MODEL_IDS,
  SUPPORTED_VIDEO_MODEL_IDS,
} from "./ai-pricing-definitions";

export type MediaRosterStatus = "wired" | "deferred" | "rejected";
export type MediaRosterSurface = "image" | "video" | "music" | "audio" | "sfx";
export type MediaRosterProvider = "fal" | "atlascloud" | "google" | "elevenlabs" | "suno";

export interface MediaModelRosterEntry {
  family: string;
  provider: MediaRosterProvider;
  surfaces: readonly MediaRosterSurface[];
  status: MediaRosterStatus;
  sourceUrls: readonly string[];
  wiredModelIds?: readonly string[];
  rationale: string;
}

export const MEDIA_MODEL_ROSTER: readonly MediaModelRosterEntry[] = [
  {
    family: "FLUX",
    provider: "fal",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: [
      "https://fal.ai/models/fal-ai/flux/schnell",
      "https://fal.ai/models/fal-ai/flux/dev",
    ],
    wiredModelIds: ["fal-ai/flux/schnell", "fal-ai/flux/dev"],
    rationale:
      "FLUX.1 Schnell and Dev are priced and routed through the existing FAL image provider.",
  },
  {
    family: "Atlas-hosted GPT Image 2",
    provider: "atlascloud",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: ["https://www.atlascloud.ai/models/list"],
    wiredModelIds: ["openai/gpt-image-2/text-to-image"],
    rationale:
      "GPT Image 2 is an Atlas Cloud image-generation model with an existing pricing definition and Atlas image provider route.",
  },
  {
    family: "Atlas-hosted Seedream",
    provider: "atlascloud",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: ["https://www.atlascloud.ai/models/list", "https://fal.ai/pricing"],
    wiredModelIds: ["bytedance/seedream-v5.0-lite"],
    rationale:
      "Seedream is part of the current hosted image roster and is already indexed as an Atlas Cloud text-to-image model.",
  },
  {
    family: "Atlas-hosted Qwen Image",
    provider: "atlascloud",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: ["https://www.atlascloud.ai/models/list"],
    wiredModelIds: ["qwen/qwen-image-2.0/text-to-image"],
    rationale:
      "Qwen Image 2.0 is already priced and routed through the Atlas Cloud image provider, so it belongs in the checked-in roster.",
  },
  {
    family: "Recraft",
    provider: "fal",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: ["https://fal.ai/models/fal-ai/recraft/v3/text-to-image"],
    wiredModelIds: ["fal-ai/recraft/v3/text-to-image"],
    rationale:
      "Recraft V3 uses the existing FAL image provider input contract and has a checked snapshot pricing row.",
  },
  {
    family: "Ideogram",
    provider: "fal",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: ["https://fal.ai/models/fal-ai/ideogram/v3"],
    wiredModelIds: ["fal-ai/ideogram/v3"],
    rationale: "Ideogram V3 routes through the existing FAL image provider with snapshot pricing.",
  },
  {
    family: "Kling",
    provider: "fal",
    surfaces: ["video"],
    status: "wired",
    sourceUrls: [
      "https://fal.ai/explore/kling",
      "https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video",
      "https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video",
      "https://fal.ai/models/fal-ai/kling-video/v2.6/pro/text-to-video",
    ],
    wiredModelIds: [
      "fal-ai/kling-video/v3/standard/text-to-video",
      "fal-ai/kling-video/v3/pro/text-to-video",
      "fal-ai/kling-video/v2.6/pro/text-to-video",
    ],
    rationale:
      "Kling v3 standard/pro and v2.6 pro are priced by the FAL video pricing parser and route through /api/v1/generate-video.",
  },
  {
    family: "MiniMax / Hailuo",
    provider: "fal",
    surfaces: ["video", "music"],
    status: "wired",
    sourceUrls: [
      "https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video",
      "https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/text-to-video",
      "https://fal.ai/models/fal-ai/minimax-music/v2.6/api",
    ],
    wiredModelIds: [
      "fal-ai/minimax/hailuo-2.3/standard/text-to-video",
      "fal-ai/minimax/hailuo-2.3/pro/text-to-video",
      "fal-ai/minimax-music/v2.6",
    ],
    rationale:
      "Hailuo 2.3 video and MiniMax Music 2.6 have supported pricing definitions; music is cataloged for pricing while video is routed.",
  },
  {
    family: "ElevenLabs Music",
    provider: "elevenlabs",
    surfaces: ["music"],
    status: "wired",
    sourceUrls: ["https://elevenlabs.io/docs/api-reference/music/compose"],
    wiredModelIds: ["elevenlabs/music_v1"],
    rationale:
      "ElevenLabs Music v1 is in the music pricing definitions and is routed by the existing generate-music provider branch.",
  },
  {
    family: "Suno-compatible music",
    provider: "suno",
    surfaces: ["music"],
    status: "wired",
    sourceUrls: ["https://docs.sunoapi.org/suno-api/generate-music/"],
    wiredModelIds: ["suno/default"],
    rationale:
      "The Suno-compatible provider remains a supported music-generation option with explicit fallback pricing.",
  },
  {
    family: "Luma",
    provider: "fal",
    surfaces: ["video"],
    status: "deferred",
    sourceUrls: ["https://fal.ai/explore/models"],
    rationale:
      "No Luma model id is currently priced or routed; add only after selecting concrete FAL endpoints and parser rules.",
  },
  {
    family: "Runway",
    provider: "fal",
    surfaces: ["video"],
    status: "deferred",
    sourceUrls: ["https://fal.ai/explore/models"],
    rationale:
      "No Runway model id is currently priced or routed; add only after endpoint, credential, and pricing behavior are confirmed.",
  },
  {
    family: "Stable Audio",
    provider: "fal",
    surfaces: ["sfx", "audio"],
    status: "wired",
    sourceUrls: ["https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio"],
    wiredModelIds: ["fal-ai/stable-audio-25/text-to-audio"],
    rationale:
      "Stable Audio 2.5 is wired through the FAL audio provider and /api/v1/generate-sfx with snapshot request pricing.",
  },
  {
    family: "ElevenLabs sound effects",
    provider: "elevenlabs",
    surfaces: ["sfx", "audio"],
    status: "wired",
    sourceUrls: ["https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert"],
    wiredModelIds: ["elevenlabs/sound_effects_v1"],
    rationale:
      "ElevenLabs sound generation is the default SFX model and returns bytes stored by the route in R2.",
  },
  {
    family: "MMAudio",
    provider: "fal",
    surfaces: ["audio"],
    status: "deferred",
    sourceUrls: ["https://fal.ai/explore/models"],
    rationale:
      "MMAudio is a video-to-audio/post-production candidate; the current public routes do not accept source video audio-generation jobs.",
  },
  {
    family: "Veo via FAL",
    provider: "fal",
    surfaces: ["video"],
    status: "wired",
    sourceUrls: [
      "https://fal.ai/models/fal-ai/veo3",
      "https://fal.ai/models/fal-ai/veo3/fast",
      "https://fal.ai/models/fal-ai/veo3.1",
      "https://fal.ai/models/fal-ai/veo3.1/fast",
      "https://fal.ai/models/fal-ai/veo3.1/lite",
    ],
    wiredModelIds: [
      "fal-ai/veo3",
      "fal-ai/veo3/fast",
      "fal-ai/veo3.1",
      "fal-ai/veo3.1/fast",
      "fal-ai/veo3.1/lite",
    ],
    rationale: "Veo 3 and Veo 3.1 variants are routed through FAL and priced by the video parser.",
  },
  {
    family: "Wan / PixVerse / Seedance",
    provider: "fal",
    surfaces: ["video"],
    status: "wired",
    sourceUrls: [
      "https://fal.ai/models/wan/v2.6/text-to-video",
      "https://fal.ai/models/fal-ai/pixverse/v5/text-to-video",
      "https://fal.ai/models/fal-ai/pixverse/v5.5/text-to-video",
      "https://fal.ai/models/fal-ai/pixverse/v5.6/text-to-video",
      "https://fal.ai/models/bytedance/seedance-2.0/text-to-video",
      "https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video",
    ],
    wiredModelIds: [
      "wan/v2.6/text-to-video",
      "fal-ai/pixverse/v5/text-to-video",
      "fal-ai/pixverse/v5.5/text-to-video",
      "fal-ai/pixverse/v5.6/text-to-video",
      "bytedance/seedance-2.0/text-to-video",
      "bytedance/seedance-2.0/fast/text-to-video",
    ],
    rationale:
      "These adjacent FAL video families are already explicit supported video models with parser coverage.",
  },
  {
    family: "Atlas-hosted Vidu video",
    provider: "atlascloud",
    surfaces: ["video"],
    status: "wired",
    sourceUrls: [
      "https://www.atlascloud.ai/docs/en/models/video",
      "https://www.atlascloud.ai/models/vidu/q3-turbo/text-to-video",
      "https://www.atlascloud.ai/models/vidu/image-to-video-2.0",
    ],
    wiredModelIds: ["vidu/q3-turbo/text-to-video", "vidu/image-to-video-2.0"],
    rationale:
      "Vidu text-to-video and image-to-video are routed through the Atlas Cloud async video provider with snapshot per-second pricing.",
  },
  {
    family: "Google Nano Banana image generation",
    provider: "atlascloud",
    surfaces: ["image"],
    status: "wired",
    sourceUrls: [
      "https://ai.google.dev/gemini-api/docs/models",
      "https://www.atlascloud.ai/providers/google",
    ],
    wiredModelIds: ["google/nano-banana-2/text-to-image"],
    rationale:
      "Nano Banana 2 is the current Google-family default image model through Atlas Cloud routing and pricing.",
  },
  {
    family: "Google Imagen 4 direct",
    provider: "google",
    surfaces: ["image"],
    status: "deferred",
    sourceUrls: [
      "https://deepmind.google/models/imagen/",
      "https://ai.google.dev/gemini-api/docs/models",
    ],
    rationale:
      "Google documents Imagen 4 capabilities, but the Gemini API model list marks Imagen 4 deprecated; this repo routes current Google image generation through Atlas-hosted Nano Banana instead.",
  },
  {
    family: "Google direct Veo 3 / Veo 3.1",
    provider: "google",
    surfaces: ["video"],
    status: "deferred",
    sourceUrls: ["https://ai.google.dev/gemini-api/docs/models"],
    rationale:
      "Direct Google Veo is a candidate, but the current production route uses FAL credentials, pricing, and response normalization for Veo variants.",
  },
  {
    family: "Gemini Omni / direct Gemini media",
    provider: "google",
    surfaces: ["image", "video", "audio"],
    status: "deferred",
    sourceUrls: ["https://ai.google.dev/gemini-api/docs/models"],
    rationale:
      "Gemini Omni and direct Gemini media need a separate Google provider adapter and route contract; no direct Google media billing source exists yet.",
  },
] as const;

export function mediaRosterModelIndexes() {
  return {
    image: new Set(SUPPORTED_IMAGE_MODEL_IDS),
    video: new Set(SUPPORTED_VIDEO_MODEL_IDS),
    music: new Set(SUPPORTED_MUSIC_MODEL_IDS),
    sfx: new Set(SUPPORTED_SFX_MODEL_IDS),
  };
}
