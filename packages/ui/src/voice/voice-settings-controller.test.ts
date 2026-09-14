/** Tests shared voice-settings mirroring across full-shell and Cloud hosts. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  saveContinuousChatMode: vi.fn(),
  saveOsIntentAutoStartConsent: vi.fn(),
  saveVadAutoStop: vi.fn(),
}));

vi.mock("../state/persistence", () => persistence);

import { createVoiceSettingsController } from "./voice-settings-controller";

describe("VoiceSettingsController", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mirrors the common device settings through one policy", () => {
    createVoiceSettingsController().applyDeviceSettings({
      continuous: "always-on",
      osIntentAutoStartVoice: true,
      osIntentAutoStartTranscription: false,
      vadAutoStop: { silenceMs: 900, speechRmsThreshold: 0.01 },
    });

    expect(persistence.saveContinuousChatMode).toHaveBeenCalledWith(
      "always-on",
    );
    expect(persistence.saveOsIntentAutoStartConsent).toHaveBeenCalledWith({
      voice: true,
      transcription: false,
    });
    expect(persistence.saveVadAutoStop).toHaveBeenCalledWith({
      silenceMs: 900,
      speechRmsThreshold: 0.01,
    });
  });

  it("does not fabricate VAD settings when that capability is absent", () => {
    createVoiceSettingsController().applyDeviceSettings({
      continuous: "off",
      osIntentAutoStartVoice: false,
      osIntentAutoStartTranscription: false,
    });
    expect(persistence.saveVadAutoStop).not.toHaveBeenCalled();
  });
});
