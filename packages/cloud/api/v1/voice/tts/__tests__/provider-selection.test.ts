/**
 * Regression coverage for cloud TTS provider selection.
 *
 * The helper is intentionally pure so typo handling and free-default routing
 * can be verified without reaching auth, billing, or either synthesis upstream.
 */

import { describe, expect, test } from "bun:test";
import { selectTtsProvider } from "../provider-selection";

describe("selectTtsProvider", () => {
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
});
