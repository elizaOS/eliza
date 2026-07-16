// @vitest-environment jsdom

/**
 * useVoiceChat end-to-end TTS playback across every configured provider. Drives
 * the real hook + real processQueue + real PlaybackFramePump against a fake Web
 * Audio graph whose buffer source auto-fires `onended`, so each provider runs
 * its full synth → decode → play → teardown path (not just the request). Covers
 * eliza-cloud, local-inference, ElevenLabs (server-proxy), and browser
 * SpeechSynthesis, plus streamed assistant speech and stop/cancel. Complements
 * the routing unit tests (`useVoiceChat.forced-cloud-tts`, `shared-runtime-voice`).
 */

import { logger } from "@elizaos/logger";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
const requestViaAgentTransport = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
  requestViaAgentTransport: (...args: unknown[]) =>
    requestViaAgentTransport(...args),
}));

import { globalAudioCache } from "../voice/voice-chat-types";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import {
  __resetDirectCloudTtsFallbackWarnings,
  useVoiceChat,
} from "./useVoiceChat";

interface FakeSource {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

const createdSources: FakeSource[] = [];

class FakeAudioWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null } = {
    onmessage: null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  state = "running";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0)),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createBufferSource = vi.fn((): FakeSource => {
    const source: FakeSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      // Auto-finish shortly after start so the playback promise resolves and
      // the full teardown path (disconnect + timer clear) runs.
      start: vi.fn(() => {
        setTimeout(() => source.onended?.(), 0);
      }),
      onended: null,
    };
    createdSources.push(source);
    return source;
  });
  decodeAudioData = vi.fn(async (audioData: ArrayBuffer) => {
    decodedAudioInputs.push(new Uint8Array(audioData.slice(0)));
    return {
      duration: 0.04,
      sampleRate: 16_000,
      length: 640,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(640).fill(0.25),
    };
  });
  close = vi.fn(async () => {});
}

class FakeUtterance extends EventTarget {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  constructor(text: string) {
    super();
    this.text = text;
  }
}

const speechSynthesisMock = {
  speaking: false,
  pending: false,
  spoken: [] as FakeUtterance[],
  cancel: vi.fn(),
  getVoices: vi.fn(() => []),
  speak: vi.fn((u: FakeUtterance) => {
    speechSynthesisMock.spoken.push(u);
    u.onstart?.();
    u.onend?.();
  }),
};

const fetchedUrls: string[] = [];
const fetchedContexts: unknown[] = [];
const decodedAudioInputs: Uint8Array[] = [];

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function installMocks() {
  fetchWithCsrf.mockReset();
  requestViaAgentTransport.mockReset();
  fetchedUrls.length = 0;
  fetchedContexts.length = 0;
  decodedAudioInputs.length = 0;
  createdSources.length = 0;
  speechSynthesisMock.spoken = [];
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
  globalAudioCache.clear();
  fetchWithCsrf.mockImplementation(async (input: unknown, _init, context) => {
    const url = typeof input === "string" ? input : String(input);
    fetchedUrls.push(url);
    fetchedContexts.push(context);
    if (url.includes("/api/voice/playback-frames")) {
      return new Response(null, { status: 204 });
    }
    // Every TTS endpoint (cloud proxy, direct worker, local-inference,
    // elevenlabs proxy) returns a decodable audio payload.
    return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  });
  requestViaAgentTransport.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  );
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: FakeAudioWorkletNode,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeUtterance,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeUtterance,
  });
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:playback-worklet"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  }
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  ) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
}

type VoiceConfigArg = Parameters<typeof useVoiceChat>[0]["voiceConfig"];

function renderVoiceChat(voiceConfig: VoiceConfigArg) {
  return renderHook(() =>
    useVoiceChat({ onTranscript: vi.fn(), voiceConfig, cloudConnected: true }),
  );
}

describe("useVoiceChat TTS playback across providers", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    installMocks();
    localStorage.clear();
    __resetDirectCloudTtsFallbackWarnings();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  it("plays an Eliza Cloud reply end to end (fetch → decode → play → finish)", async () => {
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("cloud reply one");
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(
      fetchedUrls.some(
        (url) => url.includes("/tts/") || url.includes("/voice/tts"),
      ),
    ).toBe(true);
    // Cloud Kokoro is not the browser engine — no SpeechSynthesis swap.
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();
  });

  it("requests cloud TTS as an arraybuffer and preserves bridge-decoded WAV bytes exactly", async () => {
    const wavBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x80, 0xff, 0x57, 0x41, 0x56, 0x45,
    ]);
    const encodedWav = btoa(
      Array.from(wavBytes, (byte) => String.fromCharCode(byte)).join(""),
    );
    fetchWithCsrf.mockImplementation(async (input: unknown, _init, context) => {
      const url = typeof input === "string" ? input : String(input);
      fetchedUrls.push(url);
      fetchedContexts.push(context);
      if (url.includes("/api/voice/playback-frames")) {
        return new Response(null, { status: 204 });
      }
      return new Response(bytesFromBase64(encodedWav), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });

    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("binary cloud reply");
    });

    await waitFor(() => {
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });

    const cloudCallIndex = fetchedUrls.findIndex((url) =>
      url.includes("/api/tts/cloud"),
    );
    expect(cloudCallIndex).toBeGreaterThanOrEqual(0);
    expect(fetchedContexts[cloudCallIndex]).toEqual({
      responseType: "arraybuffer",
      timeoutMs: 60_000,
    });
    expect(decodedAudioInputs[0]).toEqual(wavBytes);
    expect(result.current.ttsError ?? null).toBeNull();
  });

  it("surfaces a cloud TTS timeout instead of decoding or playing a stale healthy state", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    fetchWithCsrf.mockImplementation(async (input: unknown, _init, context) => {
      const url = typeof input === "string" ? input : String(input);
      fetchedUrls.push(url);
      fetchedContexts.push(context);
      if (url.includes("/api/tts/cloud")) {
        throw new DOMException("Eliza Cloud TTS timed out", "TimeoutError");
      }
      return new Response(null, { status: 204 });
    });
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("timeout please");
    });

    await waitFor(() => {
      expect(result.current.ttsError).not.toBeNull();
    });

    const cloudCallIndex = fetchedUrls.findIndex((url) =>
      url.includes("/api/tts/cloud"),
    );
    expect(fetchedContexts[cloudCallIndex]).toEqual({
      responseType: "arraybuffer",
      timeoutMs: 60_000,
    });
    expect(result.current.ttsError?.engine).toBe("eliza-cloud");
    expect(result.current.ttsError?.message).toContain(
      "Eliza Cloud TTS timed out",
    );
    expect(decodedAudioInputs).toEqual([]);
    expect(createdSources).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("plays a local-inference reply end to end", async () => {
    const { result } = renderVoiceChat({ provider: "local-inference" });

    act(() => {
      result.current.speak("local inference reply");
    });

    await waitFor(() => {
      expect(
        fetchedUrls.some((url) => url.includes("/api/tts/local-inference")),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
  });

  it("plays an ElevenLabs reply via the server proxy (no browser key)", async () => {
    const { result } = renderVoiceChat({
      provider: "elevenlabs",
      elevenlabs: { voiceId: "voice-x", modelId: "model-x" },
    });

    act(() => {
      result.current.speak("elevenlabs reply");
    });

    await waitFor(() => {
      expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
  });

  it("speaks via the browser when the browser is the configured engine (edge)", async () => {
    const { result } = renderVoiceChat({ provider: "edge" });

    act(() => {
      result.current.speak("browser reply");
    });

    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    // Configured browser voice: no server TTS fetch.
    expect(fetchedUrls.some((url) => url.includes("/api/tts/"))).toBe(false);
  });

  it("streams assistant speech: an early clip flushes, then the final promotes", async () => {
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    // First streamed chunk over the first-flush threshold queues a clip after
    // the debounce; the final promotes the remainder.
    act(() => {
      result.current.queueAssistantSpeech(
        "msg-stream-1",
        "This is the first streamed sentence of the reply.",
        false,
      );
    });

    await waitFor(() => {
      expect(createdSources.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.queueAssistantSpeech(
        "msg-stream-1",
        "This is the first streamed sentence of the reply. And here is the rest of it.",
        true,
      );
    });

    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
  });

  it("degrades a failed direct-cloud fetch to the proxy and still plays audio end to end", async () => {
    // A cloud session bearer + the default cloud origin select the direct
    // worker path; the direct bare fetch dies (network / preflight) and the
    // designed degrade must play the same clip through the on-device proxy.
    localStorage.setItem("steward_session_token", "header.payload.signature");
    setBootConfig({ branding: {}, cloudApiBase: "https://elizacloud.ai" });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const directFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: directFetch,
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: directFetch,
    });

    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("fallback reply");
    });

    // Both legs fired: the direct worker attempt, then the proxy rescue.
    await waitFor(() => {
      expect(directFetch).toHaveBeenCalled();
      expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
        true,
      );
    });
    // The proxy audio decoded and played to completion — user hears the reply.
    await waitFor(() => {
      expect(createdSources[0]?.start).toHaveBeenCalledWith(0);
    });
    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
    expect(result.current.ttsError ?? null).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("stopSpeaking cancels playback and clears the speaking state", async () => {
    const { result } = renderVoiceChat({ provider: "eliza-cloud" });

    act(() => {
      result.current.speak("first utterance");
      result.current.speak("second utterance", { append: true });
    });

    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(true);
    });

    act(() => {
      result.current.stopSpeaking();
    });

    await waitFor(() => {
      expect(result.current.isSpeaking).toBe(false);
    });
  });
});
