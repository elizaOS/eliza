// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VoicePrefixGate from "./VoicePrefixGate";

const mocks = vi.hoisted(() => ({
  fetchWithCsrf: vi.fn(),
  getLocalInferenceHub: vi.fn(),
  getLocalTtsStatus: vi.fn(),
  getLocalTtsDiagnostics: vi.fn(),
  synthesizeLocalTts: vi.fn(),
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
      return mocks.getLocalInferenceHub();
    }
  },
}));

vi.mock("../../api/csrf-client", () => ({
  fetchWithCsrf: mocks.fetchWithCsrf,
}));

vi.mock("@elizaos/capacitor-bun-runtime", () => ({
  ElizaBunRuntime: {
    getLocalTtsStatus: mocks.getLocalTtsStatus,
    getLocalTtsDiagnostics: mocks.getLocalTtsDiagnostics,
    synthesizeLocalTts: mocks.synthesizeLocalTts,
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

vi.mock("../../services/local-inference/recommendation", () => ({
  selectRecommendedModelForSlot: () => ({
    model: {
      id: "eliza-1-0_8b",
      displayName: "eliza-1-0.8B",
    },
  }),
}));

vi.mock("./VoicePrefixSteps", () => ({
  VoicePrefixSteps: (props: {
    onAgentSpeak?: (script: string) => void | Promise<void>;
    voiceBundleReadiness?: { status: string };
  }) => (
    <button
      type="button"
      data-testid="voice-prefix-test-speak"
      data-status={props.voiceBundleReadiness?.status ?? "missing"}
      onClick={() =>
        void Promise.resolve(props.onAgentSpeak?.("Hello from Eliza")).catch(
          () => undefined,
        )
      }
    >
      Speak
    </button>
  ),
}));

class FakeAudioContext {
  state = "running";
  destination = {};

  async resume(): Promise<void> {
    this.state = "running";
  }

  async decodeAudioData(): Promise<{ duration: number }> {
    return { duration: 0.01 };
  }

  createBufferSource(): {
    buffer: unknown;
    connect: () => void;
    disconnect: () => void;
    onended: (() => void) | null;
    start: () => void;
  } {
    const source = {
      buffer: null as unknown,
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: null as (() => void) | null,
      start: vi.fn(() => {
        source.onended?.();
      }),
    };
    return source;
  }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  mocks.fetchWithCsrf.mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
  );
  mocks.getLocalTtsStatus.mockResolvedValue({
    ready: true,
    status: "assets-ready",
    modelId: "eliza-1-0_8b",
    message:
      "Local voice assets are installed. Voice engine will warm on first playback.",
  });
  mocks.synthesizeLocalTts.mockResolvedValue({
    audioBase64: "AQIDBA==",
    contentType: "audio/wav",
    sampleRate: 24_000,
    samples: 4,
    durationMs: 1,
    modelId: "eliza-1-0_8b",
  });
  mocks.getLocalTtsDiagnostics.mockResolvedValue({
    available: true,
    selectedBundleDir: "/tmp/eliza-1-0_8b.bundle",
    modelId: "eliza-1-0_8b",
  });
  mocks.getLocalInferenceHub.mockResolvedValue({
    hardware: {},
    catalog: [],
    installed: [{ id: "eliza-1-0_8b" }],
    downloads: [],
    voiceReadiness: {
      status: "assets-ready",
      modelId: "eliza-1-0_8b",
      message:
        "Local voice assets are installed. Voice engine will warm on first playback.",
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("VoicePrefixGate", () => {
  it("routes the iOS greeting through direct native local TTS when the voice bundle is ready", async () => {
    mocks.talkModeSpeak.mockResolvedValue({
      completed: true,
      interrupted: false,
      usedSystemTts: true,
    });

    render(<VoicePrefixGate onDone={vi.fn()} />);
    const speakButton = screen.getByTestId("voice-prefix-test-speak");

    await waitFor(() => {
      expect(speakButton.getAttribute("data-status")).toBe("assets-ready");
    });

    fireEvent.click(speakButton);

    await waitFor(() => {
      expect(mocks.synthesizeLocalTts).toHaveBeenCalledWith({
        text: "Hello from Eliza",
        play: true,
        maxSamples: 480000,
      });
    });
    expect(mocks.fetchWithCsrf).not.toHaveBeenCalled();
    expect(mocks.talkModeSpeak).not.toHaveBeenCalled();
    expect(mocks.voiceSpeak).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(speakButton.getAttribute("data-status")).toBe("engine-ready");
    });
  });

  it("does not route through Bun local-inference TTS when only the text model is installed", async () => {
    mocks.getLocalTtsStatus.mockResolvedValueOnce({
      ready: false,
      status: "missing",
      message: "Eliza-1 voice assets are not installed in this iOS build.",
    });
    mocks.synthesizeLocalTts.mockRejectedValueOnce(
      new Error("Eliza-1 voice assets are not installed in this iOS build."),
    );
    mocks.getLocalInferenceHub.mockResolvedValueOnce({
      hardware: {},
      catalog: [],
      installed: [{ id: "eliza-1-0_8b" }],
      downloads: [],
      voiceReadiness: {
        status: "missing",
        message: "Eliza-1 voice assets are not installed in this iOS build.",
      },
    });

    render(<VoicePrefixGate onDone={vi.fn()} />);
    const speakButton = screen.getByTestId("voice-prefix-test-speak");

    await waitFor(() => {
      expect(speakButton.getAttribute("data-status")).toBe("unsupported");
    });

    fireEvent.click(speakButton);

    await waitFor(() => {
      expect(mocks.fetchWithCsrf).not.toHaveBeenCalled();
    });
    expect(mocks.synthesizeLocalTts).toHaveBeenCalledTimes(1);
  });
});
