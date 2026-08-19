/** Verifies useVoiceChat cloud ASR through the package's configured test harness. */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import {
  isLocalAsrCaptureSupported,
  startLocalAsrRecorder,
} from "../voice/local-asr-capture";
import { useVoiceChat } from "./useVoiceChat";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../voice/local-asr-capture", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLocalAsrCaptureSupported: vi.fn(),
  startLocalAsrRecorder: vi.fn(),
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const isLocalAsrCaptureSupportedMock = vi.mocked(isLocalAsrCaptureSupported);
const startLocalAsrRecorderMock = vi.mocked(startLocalAsrRecorder);

/**
 * Regression guard for the cloud STT wiring gap: an `eliza-cloud` / `openai`
 * voice config used to fall straight through to the browser SpeechRecognition
 * engine in the chat composer (`useVoiceChat` only branched local-inference vs
 * browser), so the documented cloud transcriber (direct worker when the cloud
 * session is available, otherwise `/api/asr/cloud`) was never
 * reached from the PWA. These tests lock the composer capture to the cloud
 * proxy when the config selects a cloud provider.
 */
describe("useVoiceChat cloud ASR", () => {
  beforeEach(() => {
    isLocalAsrCaptureSupportedMock.mockReturnValue(true);
    // The cloud path never probes /api/asr/local-inference/status; the only
    // request it makes is the WAV POST to /api/asr/cloud, which returns { text }.
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response(JSON.stringify({ text: "hello cloud voice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Any other endpoint (e.g. a stray local-inference status probe) would be
      // a regression — surface it as a 404 so the assertions below catch it.
      return new Response("unexpected endpoint", { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("records a WAV and POSTs it to /api/asr/cloud for an eliza-cloud config", async () => {
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel: vi.fn(),
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    // The WAV recorder is the capture engine — NOT browser SpeechRecognition.
    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    // The recorded WAV is POSTed to the cloud proxy as raw audio/wav bytes.
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "audio/wav",
          Accept: "application/json",
        }),
      }),
    );
    // It must NOT have consulted the local-inference readiness/transcribe route.
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/local-inference/status",
      expect.anything(),
    );
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/local-inference",
      expect.anything(),
    );

    // The cloud transcript is delivered as the final turn, tagged `cloud`.
    expect(onTranscript).toHaveBeenCalledWith(
      "hello cloud voice",
      expect.objectContaining({
        isFinal: true,
        turn: expect.objectContaining({ source: "cloud" }),
      }),
    );
  });

  it("routes an openai ASR config through the same cloud proxy", async () => {
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
      cancel: vi.fn(),
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "openai" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("compose");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "hello cloud voice",
      expect.objectContaining({
        isFinal: true,
        turn: expect.objectContaining({ source: "cloud" }),
      }),
    );
  });

  it("unready persisted local-inference degrades to the cloud WAV route when cloudConnected (#16524)", async () => {
    // The staging-Safari dead-mic shape: the saved character config pins
    // `local-inference`, the cloud agent's local ASR runtime reports
    // `{ ready: false }`, and the browser has no SpeechRecognition engine
    // (jsdom, like Safari without webkitSpeechRecognition exposure). The mic
    // must still work: record the WAV and POST it to the cloud STT proxy.
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/local-inference/status")) {
        return new Response(JSON.stringify({ ready: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/asr/cloud")) {
        return new Response(JSON.stringify({ text: "hello cloud voice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
    const stop = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    startLocalAsrRecorderMock.mockResolvedValue({
      stop,
      cancel: vi.fn(),
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        cloudConnected: true,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    // Readiness was probed once, then the WAV recorder armed for the cloud
    // route — capture never fell through to browser SpeechRecognition.
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/local-inference/status",
      expect.objectContaining({ method: "GET" }),
    );
    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({ method: "POST" }),
    );
    // The audio must NOT have been sent to the unready local transcriber.
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/local-inference",
      expect.anything(),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "hello cloud voice",
      expect.objectContaining({
        isFinal: true,
        turn: expect.objectContaining({ source: "cloud" }),
      }),
    );
  });

  it("ready persisted local-inference stays on the local route even when cloudConnected (#16524)", async () => {
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/local-inference/status")) {
        return new Response(JSON.stringify({ ready: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/asr/local-inference")) {
        return new Response(JSON.stringify({ text: "hello local voice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1, 2])),
      cancel: vi.fn(),
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        cloudConnected: true,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.anything(),
    );
    expect(onTranscript).toHaveBeenCalledWith(
      "hello local voice",
      expect.anything(),
    );
  });

  it("unready local-inference without a cloud session never arms a WAV capture (#16524)", async () => {
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/local-inference/status")) {
        return new Response(JSON.stringify({ ready: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        cloudConnected: false,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });

    // No cloud fallback to lean on: the WAV recorder must not arm (there is
    // nothing that could transcribe it) — legacy behavior preserved.
    expect(startLocalAsrRecorderMock).not.toHaveBeenCalled();
    expect(fetchWithCsrfMock).not.toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.anything(),
    );
  });

  it("never probes local readiness nor arms a recorder without WAV capture primitives (#16524)", async () => {
    // No getUserMedia/AudioContext → no WAV route can serve ANY provider; the
    // readiness probe must not even fire (nothing could record the audio).
    isLocalAsrCaptureSupportedMock.mockReturnValue(false);
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        cloudConnected: true,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });

    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
    expect(startLocalAsrRecorderMock).not.toHaveBeenCalled();
  });

  it("a second startListening while capture is armed is a no-op (single recorder)", async () => {
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/local-inference/status")) {
        return new Response(JSON.stringify({ ready: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1])),
      cancel: vi.fn(),
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        cloudConnected: true,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "local-inference" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
      await result.current.startListening("push-to-talk");
    });

    expect(startLocalAsrRecorderMock).toHaveBeenCalledTimes(1);
  });

  it("does not submit a turn when the cloud proxy fails (no silent browser downgrade)", async () => {
    startLocalAsrRecorderMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(new Uint8Array([1])),
      cancel: vi.fn(),
      analyser: null,
      inputDevice: { deviceId: "test-mic", label: "Test microphone" },
    });
    fetchWithCsrfMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/asr/cloud")) {
        return new Response("cloud down", { status: 502 });
      }
      return new Response("unexpected endpoint", { status: 404 });
    });
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript,
        voiceConfig: {
          provider: "eliza-cloud",
          asr: { provider: "eliza-cloud" },
        },
      }),
    );

    await act(async () => {
      await result.current.startListening("push-to-talk");
    });
    // The stop-time transcribe swallows the error (logs it) and simply does not
    // emit a final — the capture engine is still the cloud recorder, never a
    // browser-final substitute.
    await act(async () => {
      await result.current.stopListening({ submit: true });
    });

    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
