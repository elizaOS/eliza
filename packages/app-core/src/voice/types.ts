/**
 * Shared voice-related types and data used by VoiceConfigView, CharacterView,
 * and any other app that provides ElevenLabs / Edge voice selection.
 */

export interface VoicePreset {
  id: string;
  name: string;
  voiceId: string;
  gender: "female" | "male" | "character";
  hint: string;
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

export const PREMADE_VOICES: VoicePreset[] = [
  // Female
  {
    id: "rachel",
    name: "Rachel",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    gender: "female",
    hint: "Calm, clear",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3",
  },
  {
    id: "sarah",
    name: "Sarah",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    gender: "female",
    hint: "Soft, warm",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/6851ec91-9950-471f-8586-357c52539069.mp3",
  },
  {
    id: "matilda",
    name: "Matilda",
    voiceId: "XrExE9yKIg1WjnnlVkGX",
    gender: "female",
    hint: "Warm, friendly",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3",
  },
  {
    id: "lily",
    name: "Lily",
    voiceId: "pFZP5JQG7iQjIQuC4Bku",
    gender: "female",
    hint: "British, raspy",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/0ab8bd74-fcd2-489d-b70a-3e1bcde8c999.mp3",
  },
  {
    id: "alice",
    name: "Alice",
    voiceId: "Xb7hH8MSUJpSbSDYk0k2",
    gender: "female",
    hint: "British, confident",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/f5409e2f-d9c3-4ac9-9e7d-916a5dbd1ef1.mp3",
  },
  // Male
  {
    id: "brian",
    name: "Brian",
    voiceId: "nPczCjzI2devNBz1zQrb",
    gender: "male",
    hint: "Deep, smooth",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/f4dbda0c-aff0-45c0-93fa-f5d5ec95a2eb.mp3",
  },
  {
    id: "adam",
    name: "Adam",
    voiceId: "pNInz6obpgDQGcFmaJgB",
    gender: "male",
    hint: "Deep, authoritative",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/38a69695-2ca9-4b9e-b9ec-f07ced494a58.mp3",
  },
  {
    id: "josh",
    name: "Josh",
    voiceId: "TxGEqnHWrfWFTfGW9XjX",
    gender: "male",
    hint: "Young, deep",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/3ae2fc71-d5f9-4769-bb71-2a43633cd186.mp3",
  },
  {
    id: "daniel",
    name: "Daniel",
    voiceId: "onwK4e9ZLuTAKqWW03F9",
    gender: "male",
    hint: "British, presenter",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3",
  },
  {
    id: "liam",
    name: "Liam",
    voiceId: "TX3LPaxmHKxFdv7VOQHJ",
    gender: "male",
    hint: "Young, natural",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3",
  },
  // Character / Cutesy / Game
  {
    id: "gigi",
    name: "Gigi",
    voiceId: "jBpfuIE2acCO8z3wKNLl",
    gender: "character",
    hint: "Childish, cute",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/jBpfuIE2acCO8z3wKNLl/3a7e4339-78fa-404e-8d10-c3ef5587935b.mp3",
  },
  {
    id: "mimi",
    name: "Mimi",
    voiceId: "zrHiDhphv9ZnVXBqCLjz",
    gender: "character",
    hint: "Cute, animated",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/zrHiDhphv9ZnVXBqCLjz/decbf20b-0f57-4fac-985b-a4f0290ebfc4.mp3",
  },
  {
    id: "dorothy",
    name: "Dorothy",
    voiceId: "ThT5KcBeYPX3keUQqHPh",
    gender: "character",
    hint: "Sweet, storybook",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/ThT5KcBeYPX3keUQqHPh/981f0855-6598-48d2-9f8f-b6d92fbbe3fc.mp3",
  },
  {
    id: "glinda",
    name: "Glinda",
    voiceId: "z9fAnlkpzviPz146aGWa",
    gender: "character",
    hint: "Magical, whimsical",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/z9fAnlkpzviPz146aGWa/cbc60443-7b61-4ebb-b8e1-5c03237ea01d.mp3",
  },
  {
    id: "charlotte",
    name: "Charlotte",
    voiceId: "XB0fDUnXU5powFXDhCwa",
    gender: "character",
    hint: "Alluring, game NPC",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/XB0fDUnXU5powFXDhCwa/942356dc-f10d-4d89-bda5-4f8505ee038b.mp3",
  },
  {
    id: "callum",
    name: "Callum",
    voiceId: "N2lVS1w4EtoT3dr4eOWO",
    gender: "character",
    hint: "Gruff, game hero",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3",
  },
];

export const VOICE_PROVIDERS: Array<{
  id: "elevenlabs" | "edge";
  label: string;
  hint: string;
  needsKey: boolean;
}> = [
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    hint: "High quality, realistic voices",
    needsKey: true,
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    hint: "Free, Microsoft voices",
    needsKey: false,
  },
];
