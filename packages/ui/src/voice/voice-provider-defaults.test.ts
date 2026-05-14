import { describe, expect, it } from "vitest";
import {
  type PresetPlatform,
  type PresetRuntimeMode,
  pickDefaultVoiceProvider,
} from "./voice-provider-defaults";

describe("pickDefaultVoiceProvider", () => {
  it("desktop + local-only agent uses on-device OmniVoice + Qwen3-ASR", () => {
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

  it("mobile + local agent falls back to Eliza Cloud audio", () => {
    expect(
      pickDefaultVoiceProvider({ platform: "mobile", runtimeMode: "local" }),
    ).toEqual({ tts: "elevenlabs", asr: "eliza-cloud" });
    expect(
      pickDefaultVoiceProvider({
        platform: "mobile",
        runtimeMode: "local-only",
      }),
    ).toEqual({ tts: "elevenlabs", asr: "eliza-cloud" });
  });

  it("web + local agent also leans on Eliza Cloud audio (mobile-like)", () => {
    expect(
      pickDefaultVoiceProvider({ platform: "web", runtimeMode: "local" }),
    ).toEqual({ tts: "elevenlabs", asr: "eliza-cloud" });
  });

  it("cloud agent always routes to Eliza Cloud (any device)", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    for (const platform of platforms) {
      expect(
        pickDefaultVoiceProvider({ platform, runtimeMode: "cloud" }),
      ).toEqual({ tts: "elevenlabs", asr: "eliza-cloud" });
    }
  });

  it("remote-controller surfaces route to Eliza Cloud (any device)", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    for (const platform of platforms) {
      expect(
        pickDefaultVoiceProvider({ platform, runtimeMode: "remote" }),
      ).toEqual({ tts: "elevenlabs", asr: "eliza-cloud" });
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
