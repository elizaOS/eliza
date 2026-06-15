import { describe, expect, it, vi } from "vitest";
import {
  buildSilentWarmupWav,
  shouldWarmupVoice,
  warmVoiceModels,
} from "./voice-warmup";

describe("shouldWarmupVoice", () => {
  const base = { mobile: false, skipEnv: false };

  it("warms when on desktop and not skipped", () => {
    expect(shouldWarmupVoice(base)).toBe(true);
  });

  it("warms for cloud-only setups (localInferenceActive=false)", () => {
    expect(shouldWarmupVoice({ ...base, localInferenceActive: false })).toBe(
      true,
    );
  });

  it("skips on mobile", () => {
    expect(shouldWarmupVoice({ ...base, mobile: true })).toBe(false);
  });

  it("skips when explicitly disabled by env", () => {
    expect(shouldWarmupVoice({ ...base, skipEnv: true })).toBe(false);
  });

  it("skips on a dev hot-reload respawn (cold boot still warms)", () => {
    expect(shouldWarmupVoice({ ...base, hotReload: true })).toBe(false);
    expect(shouldWarmupVoice({ ...base, hotReload: false })).toBe(true);
  });
});

describe("buildSilentWarmupWav", () => {
  it("produces a valid little RIFF/WAVE buffer", () => {
    const wav = buildSilentWarmupWav();
    expect(wav.length).toBeGreaterThan(44); // 44-byte header + samples
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  });
});

describe("warmVoiceModels", () => {
  it("loads both TTS and STT models via useModel, in order", async () => {
    const calls: string[] = [];
    const runtime = {
      useModel: vi.fn(async (modelType: string) => {
        calls.push(modelType);
        return modelType === "TEXT_TO_SPEECH" ? new Uint8Array() : "";
      }),
    };

    await warmVoiceModels(runtime, {
      ttsType: "TEXT_TO_SPEECH",
      transcriptionType: "TRANSCRIPTION",
    });

    expect(calls).toEqual(["TEXT_TO_SPEECH", "TRANSCRIPTION"]);
  });

  it("is non-fatal: a failing TTS load still attempts STT and never rejects", async () => {
    const calls: string[] = [];
    const runtime = {
      useModel: vi.fn(async (modelType: string) => {
        calls.push(modelType);
        if (modelType === "TEXT_TO_SPEECH") {
          throw new Error("kokoro not available");
        }
        return "";
      }),
    };

    await expect(
      warmVoiceModels(runtime, {
        ttsType: "TEXT_TO_SPEECH",
        transcriptionType: "TRANSCRIPTION",
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["TEXT_TO_SPEECH", "TRANSCRIPTION"]);
  });
});
