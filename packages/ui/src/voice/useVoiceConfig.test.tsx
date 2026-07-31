// @vitest-environment jsdom

/**
 * Hook coverage for character-preset voice resolution. Runtime capability
 * selection is deterministic; compatibility reads cannot become surprise
 * settings writes.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceConfig } from "./useVoiceConfig";

const JIN_VOICE_ID = "6IwYbsNENZgAB1dtBZDp";

const hoisted = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../api/client", () => ({
  client: {
    getConfig: hoisted.getConfig,
    updateConfig: hoisted.updateConfig,
  },
}));

vi.mock("../hooks/useDefaultProviderPresets", () => ({
  useDefaultProviderPresets: () => ({
    defaults: { tts: "eliza-cloud", asr: "eliza-cloud" },
  }),
}));

vi.mock("../hooks/useResolvedTtsDefault", () => ({
  useResolvedTtsDefault: () => ({ provider: "robot-voice" }),
}));

vi.mock("../state", () => ({
  useAppSelector: () => false,
}));

beforeEach(() => {
  hoisted.getConfig.mockReset();
  hoisted.updateConfig.mockReset();
  hoisted.updateConfig.mockResolvedValue({});
});

afterEach(cleanup);

describe("useVoiceConfig character preset resolution", () => {
  it("releases a legacy implicit provider without mutating settings", async () => {
    hoisted.getConfig.mockResolvedValue({
      ui: { presetId: "jin" },
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: { voiceId: JIN_VOICE_ID },
        },
      },
    });

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(result.current.voiceConfig.provider).toBe("robot-voice");
    expect(hoisted.updateConfig).not.toHaveBeenCalled();
  });

  it("derives a fresh provider-neutral preset without mutating settings", async () => {
    hoisted.getConfig.mockResolvedValue({ ui: { presetId: "jin" } });

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(result.current.voiceConfig.provider).toBe("robot-voice");
    expect(result.current.voiceConfig.elevenlabs?.voiceId).toBe(JIN_VOICE_ID);
    expect(hoisted.updateConfig).not.toHaveBeenCalled();
  });

  it("does not migrate an explicit ElevenLabs provider whose key is redacted", async () => {
    hoisted.getConfig.mockResolvedValue({
      ui: { presetId: "jin" },
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            apiKey: "[REDACTED]",
            voiceId: JIN_VOICE_ID,
          },
        },
      },
    });

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(result.current.voiceConfig.provider).toBe("elevenlabs");
    expect(hoisted.updateConfig).not.toHaveBeenCalled();
  });
});
