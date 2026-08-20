// @vitest-environment jsdom

/**
 * Exercises character voice resolution through the shared hook with mocked
 * configuration transport and real provider-default selection boundaries.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceConfig } from "./useVoiceConfig";

const JIN_VOICE_ID = "6IwYbsNENZgAB1dtBZDp";

const hoisted = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  resolvedTtsDefault: vi.fn(),
  appState: {
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
  },
}));

vi.mock("../api/client", () => ({
  client: {
    getBaseUrl: () => "http://localhost:2138",
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
  useResolvedTtsDefault: (input: { cloudVoiceAvailable: boolean }) => {
    hoisted.resolvedTtsDefault(input);
    return {
      provider: input.cloudVoiceAvailable ? "eliza-cloud" : "robot-voice",
    };
  },
}));

vi.mock("../state", () => ({
  useAppSelector: (selector: (state: typeof hoisted.appState) => unknown) =>
    selector(hoisted.appState),
}));

beforeEach(() => {
  hoisted.getConfig.mockReset();
  hoisted.updateConfig.mockReset();
  hoisted.updateConfig.mockResolvedValue({});
  hoisted.resolvedTtsDefault.mockReset();
  hoisted.appState.elizaCloudConnected = false;
  hoisted.appState.elizaCloudVoiceProxyAvailable = false;
});

afterEach(cleanup);

describe("useVoiceConfig character preset resolution", () => {
  it("does not select Cloud voice when the route is unauthenticated", async () => {
    hoisted.appState.elizaCloudVoiceProxyAvailable = true;
    hoisted.getConfig.mockResolvedValue({});

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(hoisted.resolvedTtsDefault).toHaveBeenLastCalledWith(
      expect.objectContaining({ cloudVoiceAvailable: false }),
    );
    expect(result.current.voiceConfig.provider).toBe("robot-voice");
  });

  it("selects Cloud voice only when the configured route is authenticated", async () => {
    hoisted.appState.elizaCloudConnected = true;
    hoisted.appState.elizaCloudVoiceProxyAvailable = true;
    hoisted.getConfig.mockResolvedValue({});

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(hoisted.resolvedTtsDefault).toHaveBeenLastCalledWith(
      expect.objectContaining({ cloudVoiceAvailable: true }),
    );
    expect(result.current.voiceConfig.provider).toBe("eliza-cloud");
  });

  it("preserves an explicit Cloud provider so its failure remains visible", async () => {
    hoisted.appState.elizaCloudVoiceProxyAvailable = true;
    hoisted.getConfig.mockResolvedValue({
      messages: { tts: { provider: "eliza-cloud" } },
    });

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(result.current.voiceConfig.provider).toBe("eliza-cloud");
  });

  it("releases a legacy provider pin without mutating settings", async () => {
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

  it("derives a fresh preset without mutating settings", async () => {
    hoisted.getConfig.mockResolvedValue({ ui: { presetId: "jin" } });

    const { result } = renderHook(() => useVoiceConfig("en"));

    await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
    expect(result.current.voiceConfig.provider).toBe("robot-voice");
    expect(result.current.voiceConfig.elevenlabs?.voiceId).toBe(JIN_VOICE_ID);
    expect(hoisted.updateConfig).not.toHaveBeenCalled();
  });

  it("does not migrate an explicit provider whose key is redacted", async () => {
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
