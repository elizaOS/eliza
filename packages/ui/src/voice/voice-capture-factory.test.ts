import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Routing contract of the hook-free capture factory: an always-local profile never selects the
// platform recognizer, browser SpeechRecognition or cloud STT. Mocked platform, recorder and
// transcription; not microphone, recognition or device evidence.
const platform = vi.hoisted(() => ({
  native: true,
  talkModeStarts: 0,
  captureSupported: true,
  localReady: true,
  recorders: 0,
  localTranscriptions: 0,
  cloudTranscriptions: 0,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native },
}));
vi.mock("../bridge/native-plugins", () => ({
  getTalkModePlugin: () => ({
    start: async () => {
      platform.talkModeStarts++;
      return { started: true };
    },
    stop: async () => {},
    addListener: async () => ({ remove: async () => {} }),
    checkPermissions: async () => ({
      microphone: "granted",
      speechRecognition: "granted",
    }),
    requestPermissions: async () => ({}),
  }),
}));
vi.mock("../utils/voice-capture-debug", () => ({
  voiceCaptureDebug: () => {},
}));
vi.mock("./local-asr-capture", () => ({
  isLocalAsrCaptureSupported: () => platform.captureSupported,
  isSilentWav: () => false,
  startLocalAsrRecorder: async () => {
    platform.recorders++;
    return {
      stop: async () => new Uint8Array([1, 2, 3]),
      cancel: () => {},
      analyser: null,
    };
  },
}));
vi.mock("./local-asr-transcribe", () => ({
  isLocalInferenceAsrReady: async () => platform.localReady,
  transcribeLocalInferenceWav: async () => {
    platform.localTranscriptions++;
    return { text: "local words", words: [] };
  },
  transcribeCloudWav: async () => {
    platform.cloudTranscriptions++;
    return "cloud words";
  },
}));

const { createVoiceCapture, LocalSpeechUnavailableError } = await import(
  "./voice-capture-factory"
);

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // A renderer window on a native platform: the factory would choose TalkMode first.
  vi.stubGlobal("window", globalThis);
  Object.assign(platform, {
    native: true,
    talkModeStarts: 0,
    captureSupported: true,
    localReady: true,
    recorders: 0,
    localTranscriptions: 0,
    cloudTranscriptions: 0,
  });
});

describe("createVoiceCapture localOnly", () => {
  it("records locally on a native platform where TalkMode would otherwise win", async () => {
    const segments: { text: string; backend: string }[] = [];
    const capture = createVoiceCapture({
      localOnly: true,
      cloudConnected: true,
      asrProvider: "eliza-cloud",
      onTranscript: (segment) => segments.push(segment),
    });
    await capture.start();
    await capture.stop();
    expect(platform.talkModeStarts).toBe(0);
    expect(platform.recorders).toBe(1);
    expect(platform.cloudTranscriptions).toBe(0);
    expect(segments).toEqual([
      expect.objectContaining({
        text: "local words",
        backend: "local-inference",
      }),
    ]);
  });

  it("fails instead of switching routes when local recognition is not ready", async () => {
    platform.localReady = false;
    const states: string[] = [];
    const capture = createVoiceCapture({
      localOnly: true,
      cloudConnected: true,
      onTranscript: () => {},
      onStateChange: (state) => states.push(state),
    });
    await expect(capture.start()).rejects.toBeInstanceOf(
      LocalSpeechUnavailableError,
    );
    expect(states).toEqual(["starting", "error"]);
    expect(platform.talkModeStarts + platform.recorders).toBe(0);

    platform.localReady = true;
    platform.captureSupported = false;
    await expect(
      createVoiceCapture({ localOnly: true, onTranscript: () => {} }).start(),
    ).rejects.toBeInstanceOf(LocalSpeechUnavailableError);
    expect(platform.talkModeStarts).toBe(0);
  });

  it("keeps existing routing when localOnly is not set", async () => {
    const capture = createVoiceCapture({ onTranscript: () => {} });
    await capture.start();
    expect(platform.talkModeStarts).toBe(1);
    expect(platform.recorders).toBe(0);
    await capture.stop();
  });
});
