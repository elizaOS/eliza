/** Verifies remote-only Android builds route spoken replies through their Play-safe native bridge. */
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  playSpeak: vi.fn(async () => undefined),
  talkMode: {
    checkPermissions: vi.fn(async () => ({
      microphone: "granted",
      speechRecognition: "not_supported",
    })),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: () => true,
  },
}));

vi.mock("../bridge/native-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge/native-plugins")>()),
  getTalkModePlugin: () => h.talkMode as never,
  getElizaPlayVoicePlugin: () => ({ speak: h.playSpeak }) as never,
}));

import { useVoiceChat } from "./useVoiceChat";

describe("useVoiceChat Android Play-safe voice", () => {
  beforeEach(() => {
    h.playSpeak.mockClear();
    h.talkMode.checkPermissions.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses ElizaPlayVoice when the stripped TalkMode plugin has no speak method", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "edge" },
      }),
    );

    act(() => {
      result.current.speak("Pixel VPS voice bridge proof");
    });

    await waitFor(() => {
      expect(h.playSpeak).toHaveBeenCalledWith({
        text: "Pixel VPS voice bridge proof",
      });
    });
    expect(result.current.ttsError).toBeNull();
  });
});
