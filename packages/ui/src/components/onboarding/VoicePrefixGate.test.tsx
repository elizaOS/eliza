// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoicePrefixGate from "./VoicePrefixGate";

const mocks = vi.hoisted(() => ({
  talkModeSpeak: vi.fn(),
  voiceSpeak: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
  },
}));

vi.mock("../../api/client", () => ({
  client: {},
}));

vi.mock("../../api/client-base", () => ({
  ElizaClient: class {
    async getLocalInferenceHub() {
      throw new Error("local agent unavailable");
    }
  },
}));

vi.mock("../../api/client-voice-profiles", () => ({
  createVoiceProfilesClient: () => ({}),
}));

vi.mock("../../bridge/native-plugins", () => ({
  getTalkModePlugin: () => ({
    requestPermissions: vi.fn(async () => ({
      microphone: "granted",
      speechRecognition: "granted",
    })),
    speak: mocks.talkModeSpeak,
  }),
}));

vi.mock("../../hooks/useVoiceChat", () => ({
  useVoiceChat: () => ({
    speak: mocks.voiceSpeak,
  }),
}));

vi.mock("./VoicePrefixSteps", () => ({
  VoicePrefixSteps: (props: {
    onAgentSpeak?: (script: string) => void | Promise<void>;
  }) => (
    <button
      type="button"
      data-testid="voice-prefix-test-speak"
      onClick={() => void props.onAgentSpeak?.("Hello from Eliza")}
    >
      Speak
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VoicePrefixGate", () => {
  it("routes the iOS greeting through native TalkMode system TTS", async () => {
    mocks.talkModeSpeak.mockResolvedValue({
      completed: true,
      interrupted: false,
      usedSystemTts: true,
    });

    render(<VoicePrefixGate onDone={vi.fn()} />);
    fireEvent.click(screen.getByTestId("voice-prefix-test-speak"));

    await waitFor(() => {
      expect(mocks.talkModeSpeak).toHaveBeenCalledWith({
        text: "Hello from Eliza",
        directive: { language: "en-US", once: true },
        useLocalInferenceTts: false,
        useSystemTts: true,
      });
    });
    expect(mocks.voiceSpeak).not.toHaveBeenCalled();
  });
});
