/**
 * Regression coverage for cloud TTS provider selection.
 *
 * The helper is intentionally pure so typo handling and free-default routing
 * can be verified without reaching auth, billing, or either synthesis upstream.
 */

import { describe, expect, test } from "bun:test";
import {
  isGandrShapedVoiceId,
  isGandrVoiceId,
  isKokoroShapedVoiceId,
  isKokoroVoiceId,
  selectTtsProvider,
} from "../provider-selection";

describe("isKokoroVoiceId", () => {
  test("recognizes only the catalogued Kokoro voice ids", () => {
    expect(isKokoroVoiceId("af_heart")).toBe(true);
    expect(isKokoroVoiceId("bm_lewis")).toBe(true);
    expect(isKokoroVoiceId("af_not_a_voice")).toBe(false);
    expect(isKokoroVoiceId("custom-elevenlabs-voice")).toBe(false);
  });
});

describe("isGandrVoiceId", () => {
  test("recognizes only the catalogued Gandr voice ids", () => {
    expect(isGandrVoiceId("gandr-mia")).toBe(true);
    expect(isGandrVoiceId("gandr-lewis")).toBe(true);
    expect(isGandrVoiceId("gandr-nobody")).toBe(false);
    expect(isGandrVoiceId("af_heart")).toBe(false);
  });
});

describe("isGandrShapedVoiceId", () => {
  test("matches the Gandr naming pattern regardless of catalog membership", () => {
    expect(isGandrShapedVoiceId("gandr-mia")).toBe(true);
    expect(isGandrShapedVoiceId("gandr-nobody")).toBe(true);
    expect(isGandrShapedVoiceId("custom-elevenlabs-voice")).toBe(false);
    expect(isGandrShapedVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(false);
  });
});

describe("isKokoroShapedVoiceId", () => {
  test("matches the Kokoro naming pattern regardless of catalog membership", () => {
    expect(isKokoroShapedVoiceId("af_heart")).toBe(true);
    expect(isKokoroShapedVoiceId("af_not_a_voice")).toBe(true);
    expect(isKokoroShapedVoiceId("custom-elevenlabs-voice")).toBe(false);
    expect(isKokoroShapedVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(false);
  });
});

describe("selectTtsProvider", () => {
  test("selects configured Cartesia for unpinned defaults before Kokoro", () => {
    expect(
      selectTtsProvider({
        cartesiaConfigured: true,
        kokoroConfigured: true,
        voiceId: undefined,
      }),
    ).toEqual({
      ok: true,
      provider: "cartesia",
      fallbackReason: "configured-default",
    });

    expect(
      selectTtsProvider({
        cartesiaConfigured: true,
        kokoroConfigured: true,
        voiceId: "EXAVITQu4vr4xnSDxMaL",
      }),
    ).toEqual({
      ok: true,
      provider: "cartesia",
      fallbackReason: "configured-default-compat",
    });
  });

  test("selects configured Kokoro for omitted voice and known Kokoro ids", () => {
    expect(
      selectTtsProvider({ kokoroConfigured: true, voiceId: undefined }),
    ).toEqual({
      ok: true,
      provider: "kokoro",
      voiceId: "af_heart",
      fallbackReason: "configured-default",
    });

    expect(
      selectTtsProvider({ kokoroConfigured: true, voiceId: "af_bella" }),
    ).toEqual({
      ok: true,
      provider: "kokoro",
      voiceId: "af_bella",
      fallbackReason: "explicit-kokoro",
    });
  });

  test("rejects unsupported Kokoro-shaped voice ids before any upstream path", () => {
    const selection = selectTtsProvider({
      kokoroConfigured: true,
      voiceId: "af_not_a_voice",
    });

    expect(selection).toEqual({
      ok: false,
      provider: "kokoro",
      status: 400,
      code: "unsupported_kokoro_voice",
      error: "Unsupported Kokoro voice ID: af_not_a_voice",
      fallbackReason: "unsupported-explicit-kokoro",
    });
  });

  test("fails known Kokoro ids clearly when Kokoro is unconfigured", () => {
    expect(
      selectTtsProvider({ kokoroConfigured: false, voiceId: "af_heart" }),
    ).toEqual({
      ok: false,
      provider: "kokoro",
      status: 503,
      code: "kokoro_unconfigured",
      error: "Kokoro TTS is not configured for this environment.",
      fallbackReason: "explicit-kokoro-unconfigured",
    });
  });

  test("routes the proxy-injected legacy default to configured Kokoro", () => {
    expect(
      selectTtsProvider({
        kokoroConfigured: true,
        voiceId: "EXAVITQu4vr4xnSDxMaL",
      }),
    ).toEqual({
      ok: true,
      provider: "kokoro",
      voiceId: "af_heart",
      fallbackReason: "configured-default-compat",
    });
  });

  test("returns fallback metadata while preserving ElevenLabs custom voices", () => {
    expect(
      selectTtsProvider({ kokoroConfigured: false, voiceId: undefined }),
    ).toEqual({
      ok: true,
      provider: "elevenlabs",
      fallbackReason: "kokoro-unconfigured-default",
    });

    expect(
      selectTtsProvider({
        kokoroConfigured: true,
        voiceId: "JBFqnCBsd6RMkjVDRZzb",
      }),
    ).toEqual({
      ok: true,
      provider: "elevenlabs",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      fallbackReason: "custom-or-elevenlabs-voice",
    });
  });

  test("selects configured Gandr only for explicit gandr voice ids", () => {
    expect(
      selectTtsProvider({
        gandrConfigured: true,
        kokoroConfigured: true,
        voiceId: "gandr-mia",
      }),
    ).toEqual({
      ok: true,
      provider: "gandr",
      voiceId: "gandr-mia",
      fallbackReason: "explicit-gandr",
    });
  });

  test("never substitutes Gandr for unpinned or legacy default voices", () => {
    expect(
      selectTtsProvider({
        gandrConfigured: true,
        kokoroConfigured: false,
        voiceId: undefined,
      }),
    ).toEqual({
      ok: true,
      provider: "elevenlabs",
      fallbackReason: "kokoro-unconfigured-default",
    });

    expect(
      selectTtsProvider({
        gandrConfigured: true,
        kokoroConfigured: true,
        voiceId: undefined,
      }),
    ).toEqual({
      ok: true,
      provider: "kokoro",
      voiceId: "af_heart",
      fallbackReason: "configured-default",
    });
  });

  test("rejects unsupported Gandr-shaped voice ids before any upstream path", () => {
    expect(
      selectTtsProvider({
        gandrConfigured: true,
        kokoroConfigured: true,
        voiceId: "gandr-nobody",
      }),
    ).toEqual({
      ok: false,
      provider: "gandr",
      status: 400,
      code: "unsupported_gandr_voice",
      error: "Unsupported Gandr voice ID: gandr-nobody",
      fallbackReason: "unsupported-explicit-gandr",
    });
  });

  test("fails known Gandr ids clearly when Gandr is unconfigured", () => {
    expect(
      selectTtsProvider({
        gandrConfigured: false,
        kokoroConfigured: true,
        voiceId: "gandr-ava",
      }),
    ).toEqual({
      ok: false,
      provider: "gandr",
      status: 503,
      code: "gandr_unconfigured",
      error: "Gandr TTS is not configured for this environment.",
      fallbackReason: "explicit-gandr-unconfigured",
    });
  });
});
