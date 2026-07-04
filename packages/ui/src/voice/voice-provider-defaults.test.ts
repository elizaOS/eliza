/**
 * Unit coverage for picking the default voice provider per platform/runtime mode.
 * Pure function, no live TTS.
 */
import { describe, expect, it } from "vitest";
import {
  type PresetPlatform,
  type PresetRuntimeMode,
  pickDefaultVoiceProvider,
} from "./voice-provider-defaults";

describe("pickDefaultVoiceProvider", () => {
  it("desktop + local-only agent uses on-device OmniVoice + Gemma ASR", () => {
    expect(
      pickDefaultVoiceProvider({
        platform: "desktop",
        runtimeMode: "local-only",
      }),
    ).toEqual({ tts: "local-inference", asr: "local-inference" });
  });

  it("desktop + local (hybrid) agent still uses on-device pipelines", () => {
    expect(
      pickDefaultVoiceProvider({ platform: "desktop", runtimeMode: "local" }),
    ).toEqual({ tts: "local-inference", asr: "local-inference" });
  });

  it("mobile + local agent uses on-device Kokoro TTS with Cloud ASR", () => {
    expect(
      pickDefaultVoiceProvider({ platform: "mobile", runtimeMode: "local" }),
    ).toEqual({ tts: "local-inference", asr: "eliza-cloud" });
    expect(
      pickDefaultVoiceProvider({
        platform: "mobile",
        runtimeMode: "local-only",
      }),
    ).toEqual({ tts: "local-inference", asr: "eliza-cloud" });
  });

  it("web + local agent uses fast Edge TTS with Cloud ASR (no on-device audio)", () => {
    expect(
      pickDefaultVoiceProvider({ platform: "web", runtimeMode: "local" }),
    ).toEqual({ tts: "edge", asr: "eliza-cloud" });
  });

  it("cloud agent defaults to fast Edge TTS + Cloud ASR, never slow ElevenLabs", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    for (const platform of platforms) {
      expect(
        pickDefaultVoiceProvider({ platform, runtimeMode: "cloud" }),
      ).toEqual({ tts: "edge", asr: "eliza-cloud" });
    }
  });

  it("remote-controller surfaces default to fast Edge TTS + Cloud ASR", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    for (const platform of platforms) {
      expect(
        pickDefaultVoiceProvider({ platform, runtimeMode: "remote" }),
      ).toEqual({ tts: "edge", asr: "eliza-cloud" });
    }
  });

  it("never picks the slow ElevenLabs provider as a default in any combo", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    const modes: PresetRuntimeMode[] = [
      "local",
      "local-only",
      "cloud",
      "remote",
    ];
    for (const platform of platforms) {
      for (const runtimeMode of modes) {
        expect(
          pickDefaultVoiceProvider({ platform, runtimeMode }).tts,
        ).not.toBe("elevenlabs");
      }
    }
  });

  it("matrix is total — every (platform, runtimeMode) combo resolves", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    const modes: PresetRuntimeMode[] = [
      "local",
      "local-only",
      "cloud",
      "remote",
    ];
    for (const platform of platforms) {
      for (const runtimeMode of modes) {
        const result = pickDefaultVoiceProvider({ platform, runtimeMode });
        expect(typeof result.tts).toBe("string");
        expect(typeof result.asr).toBe("string");
      }
    }
  });
});
