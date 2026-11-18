/**
 * Shared voice contracts and voice-selection data consumed across runtime,
 * cloud, plugins, and UI surfaces.
 */

/**
 * Client-transport marker for turns owned by a realtime voice WebSocket
 * session. It travels in message metadata so normal client-chat role and
 * response policy remain unchanged while side effects can return through the
 * originating session.
 */
export const REALTIME_VOICE_CLIENT_TRANSPORT = "realtime_voice" as const;

export {
  parseVoiceUiContext,
  type VoiceUiContext,
} from "./voice/ui-context.js";

/**
 * Loopback-only identity fence stamped by the local voice bridge. The agent
 * host uses this pair to reject turns after an in-process runtime or
 * conversation replacement instead of delivering them to stale state.
 */
export const LOCAL_VOICE_RUNTIME_AGENT_HEADER =
  "X-Eliza-Local-Voice-Agent-Id" as const;
export const LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER =
  "X-Eliza-Local-Voice-Conversation-Id" as const;

export interface VoicePreset {
  id: string;
  name: string;
  nameKey?: string;
  voiceId: string;
  gender: "female" | "male" | "character";
  hint: string;
  hintKey?: string;
  previewUrl: string;
}

/**
 * Sanitize API keys: mask strings that look like real keys, pass through
 * empty/redacted values.
 */
export function sanitizeApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return apiKey;
  if (apiKey === "[REDACTED]") return apiKey;
  // If the key is long enough to be real, mask the middle
  if (apiKey.length > 8) {
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
  }
  return apiKey;
}

/**
 * Treat only non-redacted, non-masked values as usable API keys. Persisted
 * redacted or masked values like "[REDACTED]" or "abcd...wxyz" are display-only.
 */
export function hasConfiguredApiKey(
  apiKey: string | null | undefined,
): boolean {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed) return false;
  if (
    trimmed === "REDACTED" ||
    trimmed === "[REDACTED]" ||
    /^\*+$/.test(trimmed)
  ) {
    return false;
  }
  if (/^.{4}\.\.\..{4}$/.test(trimmed)) {
    return false;
  }
  return true;
}

const DEFAULT_ELEVENLABS_VOICE: VoicePreset = {
  id: "sarah",
  name: "Talia",
  voiceId: "OZ0L6eISlOejga3XjDFt",
  gender: "female",
  hint: "Warm Soft Guide",
  hintKey: "voice.hint.warm_soft_guide",
  previewUrl: "",
};

export const DEFAULT_ELEVENLABS_VOICE_ID = DEFAULT_ELEVENLABS_VOICE.voiceId;

export const PREMADE_VOICES: VoicePreset[] = [
  // Female
  {
    id: "rachel",
    name: "Rachel",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    gender: "female",
    hint: "Calm, clear",
    hintKey: "voice.hint.calm_clear",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3",
  },
  DEFAULT_ELEVENLABS_VOICE,
  {
    id: "matilda",
    name: "Maisie",
    voiceId: "QtY3JBOUKEB5xzrRfOKc",
    gender: "female",
    hint: "Friendly Casual Neighbor",
    hintKey: "voice.hint.friendly_casual_neighbor",
    previewUrl: "",
  },
  {
    id: "lily",
    name: "Florence",
    voiceId: "22N9cF8z0o7y23njdyaY",
    gender: "female",
    hint: "Atmospheric Storyteller",
    hintKey: "voice.hint.atmospheric_storyteller",
    previewUrl: "",
  },
  {
    id: "alice",
    name: "Alicia",
    voiceId: "BFd5oBc2DDna33pSi4Gf",
    gender: "female",
    hint: "Polished Global Anchor",
    hintKey: "voice.hint.polished_global_anchor",
    previewUrl: "",
  },
  // Male
  {
    id: "brian",
    name: "Sawyer",
    voiceId: "8dEUmyPMdDdK91vboYih",
    gender: "male",
    hint: "Midnight Storyteller",
    hintKey: "voice.hint.midnight_storyteller",
    previewUrl: "",
  },
  {
    id: "adam",
    name: "Adam",
    voiceId: "pNInz6obpgDQGcFmaJgB",
    gender: "male",
    hint: "Deep, authoritative",
    hintKey: "voice.hint.deep_authoritative",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/38a69695-2ca9-4b9e-b9ec-f07ced494a58.mp3",
  },
  {
    id: "josh",
    name: "Josh",
    voiceId: "TxGEqnHWrfWFTfGW9XjX",
    gender: "male",
    hint: "Young, deep",
    hintKey: "voice.hint.young_deep",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/3ae2fc71-d5f9-4769-bb71-2a43633cd186.mp3",
  },
  {
    id: "daniel",
    name: "Finley",
    voiceId: "fnYMz3F5gMEDGMWcH1ex",
    gender: "male",
    hint: "Articulate Anchor",
    hintKey: "voice.hint.articulate_anchor",
    previewUrl: "",
  },
  {
    id: "liam",
    name: "Lawrence",
    voiceId: "ktkP7Nsj67dw2zcplQYt",
    gender: "male",
    hint: "Bright and Informative",
    hintKey: "voice.hint.bright_informative",
    previewUrl: "",
  },
  // Character / Cutesy / Game
  {
    id: "gigi",
    name: "Gigi",
    voiceId: "jBpfuIE2acCO8z3wKNLl",
    gender: "character",
    hint: "Childish, cute",
    hintKey: "voice.hint.childish_cute",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/jBpfuIE2acCO8z3wKNLl/3a7e4339-78fa-404e-8d10-c3ef5587935b.mp3",
  },
  {
    id: "mimi",
    name: "Mimi",
    voiceId: "zrHiDhphv9ZnVXBqCLjz",
    gender: "character",
    hint: "Cute, animated",
    hintKey: "voice.hint.cute_animated",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/zrHiDhphv9ZnVXBqCLjz/decbf20b-0f57-4fac-985b-a4f0290ebfc4.mp3",
  },
  {
    id: "dorothy",
    name: "Dorothy",
    voiceId: "ThT5KcBeYPX3keUQqHPh",
    gender: "character",
    hint: "Sweet, storybook",
    hintKey: "voice.hint.sweet_storybook",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/ThT5KcBeYPX3keUQqHPh/981f0855-6598-48d2-9f8f-b6d92fbbe3fc.mp3",
  },
  {
    id: "glinda",
    name: "Glinda",
    voiceId: "z9fAnlkpzviPz146aGWa",
    gender: "character",
    hint: "Magical, whimsical",
    hintKey: "voice.hint.magical_whimsical",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/z9fAnlkpzviPz146aGWa/cbc60443-7b61-4ebb-b8e1-5c03237ea01d.mp3",
  },
  {
    id: "charlotte",
    name: "Charlotte",
    voiceId: "XB0fDUnXU5powFXDhCwa",
    gender: "character",
    hint: "Alluring, game NPC",
    hintKey: "voice.hint.alluring_game_npc",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/XB0fDUnXU5powFXDhCwa/942356dc-f10d-4d89-bda5-4f8505ee038b.mp3",
  },
  {
    id: "callum",
    name: "Callum",
    voiceId: "fs2OqxduwXgp9foh2xjK",
    gender: "character",
    hint: "Husky Trickster",
    hintKey: "voice.hint.husky_trickster",
    previewUrl: "",
  },
  // Custom Character Voices
  {
    id: "momo",
    name: "Momo",
    voiceId: "n7Wi4g1bhpw4Bs8HK5ph",
    gender: "female",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "yuki",
    name: "Yuki",
    voiceId: "4tRn1lSkEn13EVTuqb0g",
    gender: "female",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "rin",
    name: "Rin",
    voiceId: "cNYrMw9glwJZXR8RwbuR",
    gender: "female",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "kei",
    name: "Kei",
    voiceId: "eadgjmk4R4uojdsheG9t",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "jin",
    name: "Jin",
    voiceId: "6IwYbsNENZgAB1dtBZDp",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "satoshi",
    name: "Satoshi",
    voiceId: "7cOBG34AiHrAzs842Rdi",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "ryu",
    name: "Ryu",
    voiceId: "QzTKubutNn9TjrB7Xb2Q",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
];

export const VOICE_PROVIDERS: Array<{
  id: "eliza-cloud" | "elevenlabs" | "edge" | "local-inference";
  label: string;
  labelKey: string;
  hint: string;
  hintKey: string;
  needsKey: boolean;
  requiresCloud?: boolean;
}> = [
  {
    id: "eliza-cloud",
    label: "Eliza Cloud",
    labelKey: "voice.provider.elizaCloud",
    hint: "Free Kokoro voice through Eliza Cloud",
    hintKey: "voice.provider.elizaCloud.hint",
    needsKey: false,
    requiresCloud: true,
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    labelKey: "provider.elevenlabs",
    hint: "High quality, realistic voices",
    hintKey: "voice.provider.elevenlabs.hint",
    needsKey: true,
  },
  {
    id: "local-inference",
    label: "Local inference",
    labelKey: "voice.provider.localInference",
    hint: "On-device Kokoro",
    hintKey: "voice.provider.localInference.hint",
    needsKey: false,
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    labelKey: "voice.provider.edge",
    hint: "Free, Microsoft voices",
    hintKey: "voice.provider.edge.hint",
    needsKey: false,
  },
];

/**
 * ASR (automatic speech recognition) provider catalogue. Mirrors
 * `VOICE_PROVIDERS` so the settings UI can render a provider picker for
 * speech-to-text. The legacy whisper.cpp pipeline has been retired —
 * on-device transcription now runs through the local-inference ASR bundle.
 * Release catalog checks gate the bundle lineage before it can be selected.
 */
export const ASR_PROVIDERS: Array<{
  id: "local-inference" | "eliza-cloud" | "openai";
  label: string;
  labelKey: string;
  hint: string;
  hintKey: string;
  needsKey: boolean;
}> = [
  {
    id: "local-inference",
    label: "Local inference",
    labelKey: "asr.provider.localInference",
    hint: "On-device local ASR",
    hintKey: "asr.provider.localInference.hint",
    needsKey: false,
  },
  {
    id: "eliza-cloud",
    label: "Eliza Cloud",
    labelKey: "asr.provider.elizaCloud",
    hint: "Routed through your Eliza Cloud login",
    hintKey: "asr.provider.elizaCloud.hint",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    labelKey: "asr.provider.openai",
    hint: "Whisper hosted by OpenAI",
    hintKey: "asr.provider.openai.hint",
    needsKey: true,
  },
];

/**
 * Minimal backup voices for non-ElevenLabs providers (Edge TTS / OpenAI).
 * Only a male and female option — keeps the UI uncluttered when premium
 * voices aren't available.
 */
export const EDGE_BACKUP_VOICES: VoicePreset[] = [
  {
    id: "edge-female",
    name: "Female",
    nameKey: "voice.gender.female",
    voiceId: "en-US-AriaNeural",
    gender: "female",
    hint: "Clear, natural",
    hintKey: "voice.hint.clear_natural",
    previewUrl: "",
  },
  {
    id: "edge-male",
    name: "Male",
    nameKey: "voice.gender.male",
    voiceId: "en-US-GuyNeural",
    gender: "male",
    hint: "Deep, natural",
    hintKey: "voice.hint.deep_natural",
    previewUrl: "",
  },
];
