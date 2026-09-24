// @vitest-environment jsdom

/**
 * Exercises character voice resolution through the shared hook with mocked
 * configuration transport and real provider-default selection boundaries.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_CONFIG_UPDATED_EVENT } from "../events";
import { useVoiceConfig } from "./useVoiceConfig";

const JIN_VOICE_ID = "6IwYbsNENZgAB1dtBZDp";

const hoisted = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  resolvedTtsDefault: vi.fn(),
  appState: {
    setActionNotice: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
  },
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
  hoisted.appState.setActionNotice.mockReset();
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

describe("voice preferences after detached Settings", () => {
  it("loads the saved provider when chat regains focus and removes its listener", async () => {
    hoisted.getConfig.mockResolvedValue({
      messages: { tts: { provider: "local-inference" } },
    });
    const { result, unmount } = renderHook(() => useVoiceConfig("en"));
    await waitFor(() =>
      expect(result.current.voiceConfig.provider).toBe("local-inference"),
    );
    hoisted.getConfig.mockResolvedValue({
      messages: {
        tts: { provider: "edge", edge: { voice: "en-US-AriaNeural" } },
      },
    });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(result.current.voiceConfig.provider).toBe("edge"),
    );
    expect(result.current.voiceConfig.edge?.voice).toBe("en-US-AriaNeural");
    unmount();
    hoisted.getConfig.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(hoisted.getConfig).not.toHaveBeenCalled();
  });
});

it("does not let an earlier refresh overwrite a newer same-window save", async () => {
  let resolveRead!: (config: object) => void;
  hoisted.getConfig.mockReturnValue(
    new Promise((resolve) => {
      resolveRead = resolve;
    }),
  );
  const { result } = renderHook(() => useVoiceConfig("en"));
  act(() =>
    window.dispatchEvent(
      new CustomEvent(VOICE_CONFIG_UPDATED_EVENT, {
        detail: { provider: "edge", edge: { voice: "en-US-AriaNeural" } },
      }),
    ),
  );
  await act(async () =>
    resolveRead({ messages: { tts: { provider: "local-inference" } } }),
  );
  expect(result.current.voiceConfig.provider).toBe("edge");
  expect(result.current.voiceBootstrapTick).toBe(1);
});

it("refreshes a visible voice surface and ignores a hidden transition", async () => {
  hoisted.getConfig.mockResolvedValue({
    messages: { tts: { provider: "edge" } },
  });
  const { result, unmount } = renderHook(() => useVoiceConfig("en"));
  await waitFor(() => expect(result.current.voiceBootstrapTick).toBe(1));
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(hoisted.getConfig).toHaveBeenCalledTimes(1);
    hoisted.getConfig.mockResolvedValue({
      messages: { tts: { provider: "elevenlabs" } },
    });
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() =>
      expect(result.current.voiceConfig.provider).toBe("elevenlabs"),
    );
    unmount();
    hoisted.getConfig.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hoisted.getConfig).not.toHaveBeenCalled();
  } finally {
    visibility.mockRestore();
  }
});

it("keeps the loaded voice and reports a failed focus refresh", async () => {
  hoisted.getConfig.mockResolvedValue({
    messages: {
      tts: { provider: "edge", edge: { voice: "en-US-AriaNeural" } },
    },
  });
  const { result } = renderHook(() => useVoiceConfig("en"));
  await waitFor(() => expect(result.current.voiceConfig.provider).toBe("edge"));
  hoisted.getConfig.mockRejectedValue(new Error("temporary transport failure"));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() =>
    expect(hoisted.appState.setActionNotice).toHaveBeenCalledWith(
      expect.any(String),
      "error",
    ),
  );
  expect(result.current.voiceConfig.provider).toBe("edge");
  expect(result.current.voiceConfig.edge?.voice).toBe("en-US-AriaNeural");
  hoisted.getConfig.mockResolvedValue({
    messages: { tts: { provider: "local-inference" } },
  });
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() =>
    expect(result.current.voiceConfig.provider).toBe("local-inference"),
  );
});
