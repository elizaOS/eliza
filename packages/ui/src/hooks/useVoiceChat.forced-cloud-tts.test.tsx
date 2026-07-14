// @vitest-environment jsdom

/**
 * Forced-cloud TTS direct-worker routing (#16116). When the configured provider
 * is `eliza-cloud`, a dedicated/on-device agent must NOT relay TTS through its
 * own `/api/tts/cloud` proxy (an extra phone-side download + base64 IPC
 * re-marshal) when a cloud session bearer + configured cloud origin are present:
 * it POSTs straight to the cloud worker's `/api/v1/voice/tts`. With no cloud
 * auth the on-device proxy path is preserved. Drives the real hook + real
 * processQueue against a mocked HTTP layer and audio graph.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.fn();
vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: (...args: unknown[]) => fetchWithCsrf(...args),
}));

import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import { useVoiceChat } from "./useVoiceChat";

const CLOUD_JWT = "header.payload.signature";

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
  createBufferSource = vi.fn(() => ({
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    onended: null,
  }));
  decodeAudioData = vi.fn(async () => ({
    duration: 0.04,
    sampleRate: 16_000,
    length: 640,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(640).fill(0.25),
  }));
  close = vi.fn(async () => {});
}

const fetchedUrls: string[] = [];
const fetchedInits: (RequestInit | undefined)[] = [];

function installMocks() {
  fetchWithCsrf.mockReset();
  fetchedUrls.length = 0;
  fetchedInits.length = 0;
  fetchWithCsrf.mockImplementation(
    async (input: unknown, init?: RequestInit) => {
      fetchedUrls.push(typeof input === "string" ? input : String(input));
      fetchedInits.push(init);
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    },
  );
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  ) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
}

function authHeaderOf(init: RequestInit | undefined): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization;
}

describe("useVoiceChat forced-cloud TTS routing (#16116)", () => {
  beforeEach(() => {
    installMocks();
    localStorage.clear();
    setBootConfig({ branding: {}, cloudApiBase: "https://elizacloud.ai" });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  it("POSTs directly to the cloud worker with the cloud bearer, bypassing /api/tts/cloud", async () => {
    // A live cloud session bearer is present (canonical Steward JWT).
    localStorage.setItem("steward_session_token", CLOUD_JWT);

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "eliza-cloud" },
        cloudConnected: true,
      }),
    );

    act(() => {
      result.current.speak("hello from the cloud worker");
    });

    await waitFor(() => {
      expect(fetchWithCsrf).toHaveBeenCalled();
    });

    const ttsCall = fetchedUrls.findIndex((url) =>
      url.includes("/api/v1/voice/tts"),
    );
    expect(ttsCall).toBeGreaterThanOrEqual(0);
    // Direct to the configured cloud worker origin — NOT the on-device proxy.
    expect(fetchedUrls[ttsCall]).toBe("https://elizacloud.ai/api/v1/voice/tts");
    expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
      false,
    );
    // Carries the cloud session bearer.
    expect(authHeaderOf(fetchedInits[ttsCall])).toBe(`Bearer ${CLOUD_JWT}`);
  });

  it("honors a staging cloud origin from boot config (not hardcoded production)", async () => {
    localStorage.setItem("steward_session_token", CLOUD_JWT);
    setBootConfig({
      branding: {},
      cloudApiBase: "https://staging.elizacloud.ai",
    });

    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "eliza-cloud" },
        cloudConnected: true,
      }),
    );

    act(() => {
      result.current.speak("staging please");
    });

    await waitFor(() => {
      expect(fetchWithCsrf).toHaveBeenCalled();
    });

    expect(
      fetchedUrls.some(
        (url) => url === "https://staging.elizacloud.ai/api/v1/voice/tts",
      ),
    ).toBe(true);
    expect(
      fetchedUrls.some((url) => url.includes("elizacloud.ai/api/v1/voice/tts")),
    ).toBe(true);
  });

  it("preserves the on-device /api/tts/cloud proxy when no cloud session token exists", async () => {
    // No steward token in localStorage → no cloud bearer → proxy preserved.
    const { result } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
        voiceConfig: { provider: "eliza-cloud" },
        cloudConnected: true,
      }),
    );

    act(() => {
      result.current.speak("no cloud auth here");
    });

    await waitFor(() => {
      expect(fetchWithCsrf).toHaveBeenCalled();
    });

    expect(fetchedUrls.some((url) => url.includes("/api/tts/cloud"))).toBe(
      true,
    );
    expect(fetchedUrls.some((url) => url.includes("/api/v1/voice/tts"))).toBe(
      false,
    );
  });
});
