import { describe, expect, it } from "vitest";
import { applyVoiceProviderDefaults } from "./character-voice-config";

describe("applyVoiceProviderDefaults", () => {
  it("uses local audio defaults for a fresh desktop-local voice config", () => {
    expect(
      applyVoiceProviderDefaults(null, {
        tts: "local-inference",
        asr: "local-inference",
      }),
    ).toEqual({
      provider: "local-inference",
      asr: { provider: "local-inference" },
    });
  });

  it("preserves explicit user TTS and ASR choices", () => {
    expect(
      applyVoiceProviderDefaults(
        {
          provider: "edge",
          asr: { provider: "openai", modelId: "whisper-1" },
        },
        { tts: "local-inference", asr: "local-inference" },
      ),
    ).toEqual({
      provider: "edge",
      asr: { provider: "openai", modelId: "whisper-1" },
    });
  });
});
