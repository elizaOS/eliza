/**
 * Unit coverage for voice-provider default resolution across platform/runtime
 * combinations. Pure function, no live TTS.
 */
import { describe, expect, it } from "vitest";
import {
  applyVoiceProviderDefaults,
  resolveCharacterVoiceConfigFromAppConfig,
} from "./character-voice-config";

const JIN_VOICE_ID = "6IwYbsNENZgAB1dtBZDp";
const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";

function resolveJinVoice(tts?: Record<string, unknown>) {
  return resolveCharacterVoiceConfigFromAppConfig({
    config: {
      ui: { presetId: "jin" },
      ...(tts ? { messages: { tts } } : {}),
    },
    uiLanguage: "en",
  });
}

describe("resolveCharacterVoiceConfigFromAppConfig", () => {
  it("attaches the preset voice without pinning a TTS provider", () => {
    const resolved = resolveJinVoice();

    expect(resolved).toEqual({
      elevenlabs: {
        voiceId: JIN_VOICE_ID,
        modelId: ELEVENLABS_MODEL_ID,
      },
    });
    expect(
      applyVoiceProviderDefaults(
        resolved,
        { tts: "eliza-cloud", asr: "eliza-cloud" },
        "robot-voice",
      ).provider,
    ).toBe("robot-voice");
  });

  it("releases a legacy implicit ElevenLabs provider pin", () => {
    expect(
      resolveJinVoice({
        provider: "elevenlabs",
        elevenlabs: { voiceId: JIN_VOICE_ID },
      }),
    ).toEqual({ elevenlabs: { voiceId: JIN_VOICE_ID } });
  });

  it.each(["cloud", "own-key"] as const)(
    "preserves an explicit ElevenLabs %s mode",
    (mode) => {
      const voiceConfig = {
        provider: "elevenlabs" as const,
        mode,
        elevenlabs: { voiceId: JIN_VOICE_ID },
      };

      expect(resolveJinVoice(voiceConfig)).toEqual(voiceConfig);
    },
  );

  it("preserves an explicit ElevenLabs choice with a usable key", () => {
    const voiceConfig = {
      provider: "elevenlabs" as const,
      elevenlabs: {
        apiKey: "sk-live-elevenlabs-key",
        voiceId: JIN_VOICE_ID,
      },
    };

    expect(resolveJinVoice(voiceConfig)).toEqual(voiceConfig);
  });

  it("preserves an explicit provider from the redacted config response", () => {
    const voiceConfig = {
      provider: "elevenlabs" as const,
      elevenlabs: {
        apiKey: "[REDACTED]",
        voiceId: JIN_VOICE_ID,
      },
    };

    expect(resolveJinVoice(voiceConfig)).toEqual(voiceConfig);
  });
});

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
