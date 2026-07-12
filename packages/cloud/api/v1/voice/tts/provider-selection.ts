/**
 * Provider selection for the cloud voice TTS route.
 *
 * The route keeps Kokoro as the free default when it is configured, while
 * preserving arbitrary ElevenLabs voice ids for custom voices. Explicit
 * Kokoro-shaped ids are fail-closed so a typo never waits on, or bills through,
 * the ElevenLabs upstream.
 */

const DEFAULT_KOKORO_VOICE_ID = "af_heart";
/**
 * Default injected by the existing cloud TTS proxy when callers omit voiceId.
 * Exported so the route can recognize "caller did not pin a voice" (the proxy
 * normalizes omitted/OpenAI/Edge voice names to this id before forwarding) —
 * the gate for provider substitutions that would change voice identity.
 */
export const LEGACY_DEFAULT_ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const KOKORO_VOICE_ID_PATTERN = /^[ab][fm]_[a-z0-9][a-z0-9_-]*$/;

export const KOKORO_VOICE_IDS = new Set([
  DEFAULT_KOKORO_VOICE_ID,
  "af_bella",
  "af_sarah",
  "af_nicole",
  "af_sky",
  "am_michael",
  "am_adam",
  "bf_emma",
  "bf_isabella",
  "bm_george",
  "bm_lewis",
]);

export type TtsProvider = "kokoro" | "elevenlabs";

export type TtsProviderSelection =
  | {
      ok: true;
      provider: "kokoro";
      voiceId: string;
      fallbackReason:
        | "configured-default"
        | "configured-default-compat"
        | "explicit-kokoro";
    }
  | {
      ok: true;
      provider: "elevenlabs";
      voiceId?: string;
      fallbackReason:
        | "kokoro-unconfigured-default"
        | "custom-or-elevenlabs-voice";
    }
  | {
      ok: false;
      provider: "kokoro";
      status: 400 | 503;
      code: "unsupported_kokoro_voice" | "kokoro_unconfigured";
      error: string;
      fallbackReason:
        | "unsupported-explicit-kokoro"
        | "explicit-kokoro-unconfigured";
    };

export function isKokoroVoiceId(voiceId: string): boolean {
  return KOKORO_VOICE_IDS.has(voiceId);
}

export function isKokoroShapedVoiceId(voiceId: string): boolean {
  return KOKORO_VOICE_ID_PATTERN.test(voiceId);
}

export function selectTtsProvider(args: {
  voiceId?: string;
  kokoroConfigured: boolean;
}): TtsProviderSelection {
  const voiceId = args.voiceId?.trim();

  if (!voiceId) {
    if (args.kokoroConfigured) {
      return {
        ok: true,
        provider: "kokoro",
        voiceId: DEFAULT_KOKORO_VOICE_ID,
        fallbackReason: "configured-default",
      };
    }
    return {
      ok: true,
      provider: "elevenlabs",
      fallbackReason: "kokoro-unconfigured-default",
    };
  }

  // The server cloud proxy normalizes omitted/OpenAI/Edge voice names to this
  // legacy ElevenLabs default before forwarding. Treat it as the product
  // default when Kokoro is available, while retaining the legacy fallback when
  // Kokoro is not configured.
  if (args.kokoroConfigured && voiceId === LEGACY_DEFAULT_ELEVENLABS_VOICE_ID) {
    return {
      ok: true,
      provider: "kokoro",
      voiceId: DEFAULT_KOKORO_VOICE_ID,
      fallbackReason: "configured-default-compat",
    };
  }

  if (isKokoroVoiceId(voiceId)) {
    if (args.kokoroConfigured) {
      return {
        ok: true,
        provider: "kokoro",
        voiceId,
        fallbackReason: "explicit-kokoro",
      };
    }
    return {
      ok: false,
      provider: "kokoro",
      status: 503,
      code: "kokoro_unconfigured",
      error: "Kokoro TTS is not configured for this environment.",
      fallbackReason: "explicit-kokoro-unconfigured",
    };
  }

  if (isKokoroShapedVoiceId(voiceId)) {
    return {
      ok: false,
      provider: "kokoro",
      status: 400,
      code: "unsupported_kokoro_voice",
      error: `Unsupported Kokoro voice ID: ${voiceId}`,
      fallbackReason: "unsupported-explicit-kokoro",
    };
  }

  return {
    ok: true,
    provider: "elevenlabs",
    voiceId,
    fallbackReason: "custom-or-elevenlabs-voice",
  };
}
