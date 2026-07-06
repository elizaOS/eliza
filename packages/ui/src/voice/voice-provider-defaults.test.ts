/**
 * Unit coverage for picking the default voice provider per platform/runtime mode.
 * Pure function, no live TTS.
 */
import { describe, expect, it } from "vitest";
import {
  BROWSER_TTS_PROVIDER,
  type PresetPlatform,
  type PresetRuntimeMode,
  pickDefaultVoiceProvider,
  resolveDefaultTtsProvider,
  type VoiceCapabilitySnapshot,
} from "./voice-provider-defaults";

/** No backend can run — the terminal (browser SpeechSynthesis) case. */
const NO_CAPABILITIES: VoiceCapabilitySnapshot = {
  localInferenceTtsReady: false,
  cloudVoiceAvailable: false,
  elevenLabsKeyConfigured: false,
};

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

  it("web + local agent uses cloud Kokoro TTS with Cloud ASR (no on-device audio)", () => {
    expect(
      pickDefaultVoiceProvider({ platform: "web", runtimeMode: "local" }),
    ).toEqual({ tts: "eliza-cloud", asr: "eliza-cloud" });
  });

  it("cloud agent defaults to cloud Kokoro TTS + Cloud ASR, never slow ElevenLabs", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    for (const platform of platforms) {
      expect(
        pickDefaultVoiceProvider({ platform, runtimeMode: "cloud" }),
      ).toEqual({ tts: "eliza-cloud", asr: "eliza-cloud" });
    }
  });

  it("remote-controller surfaces default to cloud Kokoro TTS + Cloud ASR", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    for (const platform of platforms) {
      expect(
        pickDefaultVoiceProvider({ platform, runtimeMode: "remote" }),
      ).toEqual({ tts: "eliza-cloud", asr: "eliza-cloud" });
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

describe("resolveDefaultTtsProvider — capability-aware default chain", () => {
  it("desktop-local prefers on-device Kokoro when the engine is staged", () => {
    expect(
      resolveDefaultTtsProvider(
        { platform: "desktop", runtimeMode: "local" },
        {
          localInferenceTtsReady: true,
          cloudVoiceAvailable: true,
          elevenLabsKeyConfigured: true,
        },
      ),
    ).toBe("local-inference");
  });

  it("desktop-local falls to Eliza Cloud Kokoro when the on-device engine is NOT staged", () => {
    expect(
      resolveDefaultTtsProvider(
        { platform: "desktop", runtimeMode: "local" },
        {
          localInferenceTtsReady: false,
          cloudVoiceAvailable: true,
          elevenLabsKeyConfigured: true,
        },
      ),
    ).toBe("eliza-cloud");
  });

  it("mobile-local prefers on-device Kokoro when staged (native TalkMode carries it in practice)", () => {
    expect(
      resolveDefaultTtsProvider(
        { platform: "mobile", runtimeMode: "local-only" },
        {
          localInferenceTtsReady: true,
          cloudVoiceAvailable: false,
          elevenLabsKeyConfigured: false,
        },
      ),
    ).toBe("local-inference");
  });

  it("web/cloud uses Eliza Cloud Kokoro when a cloud session exists", () => {
    for (const platform of ["web", "desktop", "mobile"] as PresetPlatform[]) {
      expect(
        resolveDefaultTtsProvider(
          { platform, runtimeMode: "cloud" },
          {
            localInferenceTtsReady: false,
            cloudVoiceAvailable: true,
            elevenLabsKeyConfigured: true,
          },
        ),
      ).toBe("eliza-cloud");
    }
  });

  it("prefers a staged on-device Kokoro over ElevenLabs even when the platform preferred cloud but no session exists", () => {
    // web/cloud preference is eliza-cloud, but there is no cloud session — a
    // locally-staged voice still beats the key-gated remote one.
    expect(
      resolveDefaultTtsProvider(
        { platform: "web", runtimeMode: "cloud" },
        {
          localInferenceTtsReady: true,
          cloudVoiceAvailable: false,
          elevenLabsKeyConfigured: true,
        },
      ),
    ).toBe("local-inference");
  });

  it("uses ElevenLabs only when a key is configured and no Kokoro transport is available", () => {
    expect(
      resolveDefaultTtsProvider(
        { platform: "web", runtimeMode: "cloud" },
        {
          localInferenceTtsReady: false,
          cloudVoiceAvailable: false,
          elevenLabsKeyConfigured: true,
        },
      ),
    ).toBe("elevenlabs");
  });

  it("never selects ElevenLabs without a configured key", () => {
    expect(
      resolveDefaultTtsProvider(
        { platform: "web", runtimeMode: "cloud" },
        {
          localInferenceTtsReady: false,
          cloudVoiceAvailable: false,
          elevenLabsKeyConfigured: false,
        },
      ),
    ).not.toBe("elevenlabs");
  });

  it("terminates at browser SpeechSynthesis when nothing else can run", () => {
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
          resolveDefaultTtsProvider({ platform, runtimeMode }, NO_CAPABILITIES),
        ).toBe(BROWSER_TTS_PROVIDER);
      }
    }
  });

  it("resolves to a runnable provider for every capability combination", () => {
    const platforms: PresetPlatform[] = ["desktop", "mobile", "web"];
    const modes: PresetRuntimeMode[] = [
      "local",
      "local-only",
      "cloud",
      "remote",
    ];
    const bools = [false, true];
    for (const platform of platforms) {
      for (const runtimeMode of modes) {
        for (const localInferenceTtsReady of bools) {
          for (const cloudVoiceAvailable of bools) {
            for (const elevenLabsKeyConfigured of bools) {
              const provider = resolveDefaultTtsProvider(
                { platform, runtimeMode },
                {
                  localInferenceTtsReady,
                  cloudVoiceAvailable,
                  elevenLabsKeyConfigured,
                },
              );
              // The resolved provider must correspond to a capability that is
              // actually present — never a backend that would fail on the first
              // utterance. Browser TTS is always runnable in a renderer.
              if (provider === "local-inference") {
                expect(localInferenceTtsReady).toBe(true);
              } else if (provider === "eliza-cloud") {
                expect(cloudVoiceAvailable).toBe(true);
              } else if (provider === "elevenlabs") {
                expect(elevenLabsKeyConfigured).toBe(true);
              } else {
                expect(provider).toBe(BROWSER_TTS_PROVIDER);
              }
            }
          }
        }
      }
    }
  });

  it("the chain strictly prefers Kokoro (either transport) over ElevenLabs", () => {
    // Whenever ANY Kokoro transport is available and a key is also configured,
    // ElevenLabs must not win — Kokoro is the default, ElevenLabs is opt-in.
    const kokoroCapable: VoiceCapabilitySnapshot[] = [
      {
        localInferenceTtsReady: true,
        cloudVoiceAvailable: false,
        elevenLabsKeyConfigured: true,
      },
      {
        localInferenceTtsReady: false,
        cloudVoiceAvailable: true,
        elevenLabsKeyConfigured: true,
      },
    ];
    for (const caps of kokoroCapable) {
      for (const platform of ["desktop", "mobile", "web"] as PresetPlatform[]) {
        for (const runtimeMode of [
          "local",
          "local-only",
          "cloud",
          "remote",
        ] as PresetRuntimeMode[]) {
          expect(
            resolveDefaultTtsProvider({ platform, runtimeMode }, caps),
          ).not.toBe("elevenlabs");
        }
      }
    }
  });
});
