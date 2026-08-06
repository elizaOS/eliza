import { describe, expect, it } from "vitest";
import { resolveTelegramAudioInputSettings } from "./settings";

describe("resolveTelegramAudioInputSettings", () => {
  it("returns Grok STT defaults when audio input is unset", () => {
    expect(resolveTelegramAudioInputSettings(undefined)).toEqual({
      enabled: true,
      language: "en",
    });
  });

  it("preserves explicit telegram audio overrides", () => {
    expect(
      resolveTelegramAudioInputSettings({
        audioInput: {
          enabled: false,
          language: "fr",
        },
      }),
    ).toEqual({
      enabled: false,
      language: "fr",
    });
  });

  it("ignores deprecated whisper-only keys without failing", () => {
    const legacy = {
      audioInput: {
        enabled: true,
        language: "en",
        binaryPath: "/opt/whisper-cli",
        model: "base.en",
        modelPath: "/tmp/ggml-base.en.bin",
        autoDownloadModel: false,
        engine: "whisper.cpp",
      },
    } as unknown as Parameters<typeof resolveTelegramAudioInputSettings>[0];

    expect(resolveTelegramAudioInputSettings(legacy)).toEqual({
      enabled: true,
      language: "en",
    });
  });
});
