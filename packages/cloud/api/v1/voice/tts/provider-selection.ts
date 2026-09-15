/**
 * Provider selection for the cloud voice TTS route.
 *
 * The route prefers an explicitly configured Cartesia cloud default, keeps
 * Kokoro as the free fallback when Cartesia is absent, and preserves arbitrary
 * ElevenLabs voice ids for custom voices. Explicit Kokoro-shaped ids are
 * fail-closed so a typo never waits on, or bills through, the ElevenLabs
 * upstream. Explicit `gandr-*` voice ids route to the Gandr lane and are
 * fail-closed the same way; Gandr never substitutes for an unpinned default.
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

const GANDR_VOICE_ID_PATTERN = /^gandr-[a-z0-9][a-z0-9_-]*$/;

/** Voices served by Gandr's speech endpoint. */
export const GANDR_VOICE_IDS = new Set([
  "gandr-mia",
  "gandr-ava",
  "gandr-jenny",
  "gandr-dane",
  "gandr-leo",
  "gandr-lewis",
]);

export type TtsProvider = "cartesia" | "gandr" | "kokoro" | "elevenlabs";

export type TtsProviderSelection =
  | {
      ok: true;
      provider: "cartesia";
      voiceId?: string;
      fallbackReason: "configured-default" | "configured-default-compat";
    }
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
      provider: "gandr";
      voiceId: string;
      fallbackReason: "explicit-gandr";
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
    }
  | {
      ok: false;
      provider: "gandr";
      status: 400 | 503;
      code: "unsupported_gandr_voice" | "gandr_unconfigured";
      error: string;
      fallbackReason:
        | "unsupported-explicit-gandr"
        | "explicit-gandr-unconfigured";
    };

export function isKokoroVoiceId(voiceId: string): boolean {
  return KOKORO_VOICE_IDS.has(voiceId);
}

export function isKokoroShapedVoiceId(voiceId: string): boolean {
  return KOKORO_VOICE_ID_PATTERN.test(voiceId);
}

export function isGandrVoiceId(voiceId: string): boolean {
  return GANDR_VOICE_IDS.has(voiceId);
}

export function isGandrShapedVoiceId(voiceId: string): boolean {
  return GANDR_VOICE_ID_PATTERN.test(voiceId);
}

export function selectTtsProvider(args: {
  voiceId?: string;
  cartesiaConfigured?: boolean;
  gandrConfigured?: boolean;
  kokoroConfigured: boolean;
}): TtsProviderSelection {
  const voiceId = args.voiceId?.trim();

  if (!voiceId) {
    if (args.cartesiaConfigured) {
      return {
        ok: true,
        provider: "cartesia",
        fallbackReason: "configured-default",
      };
    }
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
  // default for configured cloud defaults, while retaining the legacy fallback
  // when neither Cartesia nor Kokoro is configured.
  if (voiceId === LEGACY_DEFAULT_ELEVENLABS_VOICE_ID) {
    if (args.cartesiaConfigured) {
      return {
        ok: true,
        provider: "cartesia",
        fallbackReason: "configured-default-compat",
      };
    }
    if (!args.kokoroConfigured) {
      return {
        ok: true,
        provider: "elevenlabs",
        voiceId,
        fallbackReason: "kokoro-unconfigured-default",
      };
    }
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

  if (isGandrVoiceId(voiceId)) {
    if (args.gandrConfigured) {
      return {
        ok: true,
        provider: "gandr",
        voiceId,
        fallbackReason: "explicit-gandr",
      };
    }
    return {
      ok: false,
      provider: "gandr",
      status: 503,
      code: "gandr_unconfigured",
      error: "Gandr TTS is not configured for this environment.",
      fallbackReason: "explicit-gandr-unconfigured",
    };
  }

  if (isGandrShapedVoiceId(voiceId)) {
    return {
      ok: false,
      provider: "gandr",
      status: 400,
      code: "unsupported_gandr_voice",
      error: `Unsupported Gandr voice ID: ${voiceId}`,
      fallbackReason: "unsupported-explicit-gandr",
    };
  }

  return {
    ok: true,
    provider: "elevenlabs",
    voiceId,
    fallbackReason: "custom-or-elevenlabs-voice",
  };
}
