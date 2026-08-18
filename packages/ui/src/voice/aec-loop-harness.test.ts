/**
 * Verifies the AEC evidence harness hash contract and request deadlines through
 * the production native-client seam, with raw fetch reserved for external audio.
 */
import { describe, expect, it, vi } from "vitest";
import { createAndroidNativeAgentTransport } from "../api/android-native-agent-transport";
import { ElizaClient } from "../api/client-base";
import {
  AEC_LOOP_AEC_CAPTURE_GET_TIMEOUT_MS,
  AEC_LOOP_AEC_CAPTURE_POST_TIMEOUT_MS,
  AEC_LOOP_AUDIO_FRAMES_POST_TIMEOUT_MS,
  AEC_LOOP_AUDIO_URL_GET_TIMEOUT_MS,
  AEC_LOOP_NEAR_END_AUDIO_GET_TIMEOUT_MS,
  AEC_LOOP_PLAYBACK_FRAMES_POST_TIMEOUT_MS,
  AEC_LOOP_STATUS_GET_TIMEOUT_MS,
  getAecLoopAudioUrlWithFetch,
  getAecLoopJsonWithClient,
  getAecLoopNearEndAudioWithFetch,
  parseAecLoopHash,
  postAecLoopJsonWithClient,
  postAecLoopTtsWithClient,
} from "./aec-loop-harness";

interface NativeRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

interface NativeRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
  bodyBase64?: string | null;
}

function clientWithNativeRequest(
  request: (options: NativeRequestOptions) => Promise<NativeRequestResult>,
): ElizaClient {
  const apiClient = new ElizaClient("eliza-local-agent://ipc", "token");
  apiClient.setRequestTransport(createAndroidNativeAgentTransport({ request }));
  return apiClient;
}

describe("parseAecLoopHash (#11373)", () => {
  it("returns null for unrelated hashes", () => {
    expect(parseAecLoopHash("")).toBeNull();
    expect(parseAecLoopHash("#chat?voice=1")).toBeNull();
    expect(parseAecLoopHash("#aec-loops")).toBeNull();
    expect(parseAecLoopHash("#aec-loop-extra")).toBeNull();
  });

  it("matches the bare route with defaults", () => {
    expect(parseAecLoopHash("#aec-loop")).toEqual({});
    expect(parseAecLoopHash("#/aec-loop")).toEqual({});
  });

  it("parses run options from the query", () => {
    const options = parseAecLoopHash(
      "#aec-loop?tag=double-talk&maxSeconds=25&tailMs=3000&warmupMs=500&text=hello%20there&pagePcm=0",
    );
    expect(options).toEqual({
      tag: "double-talk",
      maxSeconds: 25,
      tailMs: 3000,
      warmupMs: 500,
      ttsText: "hello there",
      includePagePcm: false,
    });
  });

  it("parses the near-end (double-talk) audio URL", () => {
    expect(
      parseAecLoopHash("#aec-loop?nearUrl=https%3A%2F%2Fexample.test%2Fn.wav"),
    ).toEqual({ nearEndAudioUrl: "https://example.test/n.wav" });
  });

  it("ignores malformed numeric params", () => {
    expect(
      parseAecLoopHash("#aec-loop?maxSeconds=abc&tailMs=-5&warmupMs=nope"),
    ).toEqual({});
  });
});

describe("AEC-loop internal native-client deadlines", () => {
  it("keeps documented independent JSON and external-audio budgets", () => {
    expect(AEC_LOOP_STATUS_GET_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AEC_CAPTURE_GET_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AEC_CAPTURE_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_PLAYBACK_FRAMES_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AUDIO_FRAMES_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AUDIO_URL_GET_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_NEAR_END_AUDIO_GET_TIMEOUT_MS).toBe(15_000);
  });

  it("forwards a JSON GET deadline into the native request context", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: true }),
    }));
    const apiClient = clientWithNativeRequest(request);

    await expect(
      getAecLoopJsonWithClient(
        "/api/voice/audio-frames/status",
        apiClient,
        3210,
      ),
    ).resolves.toEqual({ ready: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/voice/audio-frames/status",
        timeoutMs: 3210,
      }),
    );
  });

  it("forwards a JSON POST deadline and body into native", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ armed: true }),
    }));
    const apiClient = clientWithNativeRequest(request);

    await expect(
      postAecLoopJsonWithClient(
        "/api/voice/aec-capture",
        { arm: true },
        apiClient,
        4321,
      ),
    ).resolves.toEqual({ armed: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/voice/aec-capture",
        timeoutMs: 4321,
        body: JSON.stringify({ arm: true }),
      }),
    );
  });

  it("preserves the canonical three-minute cold local-TTS budget", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "audio/wav" },
      bodyBase64: "AQID",
    }));
    const apiClient = clientWithNativeRequest(request);

    const bytes = await postAecLoopTtsWithClient(
      "/api/tts/local-inference",
      { text: "hello" },
      apiClient,
    );

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/tts/local-inference",
        timeoutMs: 180_000,
      }),
    );
  });

  it("surfaces non-ok internal responses through ApiError", async () => {
    const request = vi.fn(async () => ({
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "unavailable" }),
    }));

    await expect(
      getAecLoopJsonWithClient(
        "/api/voice/audio-frames/status",
        clientWithNativeRequest(request),
        5000,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected AEC-loop abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("AEC-loop external audio deadlines", () => {
  it("aborts a stalled far-end audio request", async () => {
    await expect(
      getAecLoopAudioUrlWithFetch(
        "https://example.test/far.wav",
        stallUntilAborted(),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline active while an external audio body stalls", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected external-audio abort signal");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    };

    await expect(
      getAecLoopAudioUrlWithFetch(
        "https://example.test/far.wav",
        fetchImpl,
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("bounds the external response body and returns its bytes", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(new Uint8Array([4, 5]), { status: 200 });
    };

    const bytes = await getAecLoopNearEndAudioWithFetch(
      "https://example.test/near.wav",
      fetchImpl,
      1000,
    );

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([4, 5]));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("surfaces non-ok external audio responses", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 404, statusText: "Not Found" });

    await expect(
      getAecLoopAudioUrlWithFetch(
        "https://example.test/far.wav",
        fetchImpl,
        1000,
      ),
    ).rejects.toThrow("audioUrl -> 404");
  });
});
