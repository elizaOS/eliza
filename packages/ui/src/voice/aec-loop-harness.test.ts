/**
 * `#aec-loop?...` hash-trigger parsing for the on-device AEC evidence harness
 * (#11373). The acoustic loop itself is device-only (getUserMedia + Web Audio
 * + the on-device agent); what is unit-testable is the trigger contract the
 * `elizaos://aec-loop?...` deep link relies on.
 */

import { describe, expect, it } from "vitest";
import {
  AEC_LOOP_AEC_CAPTURE_GET_TIMEOUT_MS,
  AEC_LOOP_AEC_CAPTURE_POST_TIMEOUT_MS,
  AEC_LOOP_AUDIO_FRAMES_POST_TIMEOUT_MS,
  AEC_LOOP_AUDIO_URL_GET_TIMEOUT_MS,
  AEC_LOOP_NEAR_END_AUDIO_GET_TIMEOUT_MS,
  AEC_LOOP_PLAYBACK_FRAMES_POST_TIMEOUT_MS,
  AEC_LOOP_STATUS_GET_TIMEOUT_MS,
  AEC_LOOP_TTS_POST_TIMEOUT_MS,
  getAecLoopAudioUrlWithFetch,
  getAecLoopJsonWithFetch,
  getAecLoopNearEndAudioWithFetch,
  parseAecLoopHash,
  postAecLoopJsonWithFetch,
  postAecLoopTtsWithFetch,
} from "./aec-loop-harness";

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

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected aec-loop abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

const STATUS_URL = "/api/voice/audio-frames/status";
const AEC_CAPTURE_URL = "/api/voice/aec-capture";
const TTS_URL = "/api/tts/local-inference";
const AUDIO_URL = "https://example.test/far.wav";
const NEAR_URL = "https://example.test/near.wav";

describe("aec-loop independent request deadlines", () => {
  it("keeps a documented 15s budget per hop", () => {
    expect(AEC_LOOP_STATUS_GET_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AEC_CAPTURE_GET_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AEC_CAPTURE_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_PLAYBACK_FRAMES_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AUDIO_FRAMES_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_AUDIO_URL_GET_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_TTS_POST_TIMEOUT_MS).toBe(15_000);
    expect(AEC_LOOP_NEAR_END_AUDIO_GET_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled status GET at the injected deadline", async () => {
    await expect(
      getAecLoopJsonWithFetch(STATUS_URL, stallUntilAborted(), 10, STATUS_URL),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed status GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("{}", { status: 503, statusText: "Service Unavailable" });
    await expect(
      getAecLoopJsonWithFetch(STATUS_URL, fetchImpl, 1_000, STATUS_URL),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful status GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ ok: true });
    };
    await expect(
      getAecLoopJsonWithFetch(STATUS_URL, fetchImpl, 1_000, STATUS_URL),
    ).resolves.toEqual({ ok: true });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("aborts a stalled aec-capture GET at its own deadline", async () => {
    await expect(
      getAecLoopJsonWithFetch(
        AEC_CAPTURE_URL,
        stallUntilAborted(),
        10,
        AEC_CAPTURE_URL,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed aec-capture GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("{}", { status: 503, statusText: "Service Unavailable" });
    await expect(
      getAecLoopJsonWithFetch(
        AEC_CAPTURE_URL,
        fetchImpl,
        1_000,
        AEC_CAPTURE_URL,
      ),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful aec-capture GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ armed: false });
    };
    await expect(
      getAecLoopJsonWithFetch(
        AEC_CAPTURE_URL,
        fetchImpl,
        1_000,
        AEC_CAPTURE_URL,
      ),
    ).resolves.toEqual({ armed: false });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("aborts a stalled aec-capture POST at its own deadline", async () => {
    await expect(
      postAecLoopJsonWithFetch(
        AEC_CAPTURE_URL,
        { arm: true },
        stallUntilAborted(),
        10,
        AEC_CAPTURE_URL,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed aec-capture POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("{}", { status: 503, statusText: "Service Unavailable" });
    await expect(
      postAecLoopJsonWithFetch(
        AEC_CAPTURE_URL,
        { arm: true },
        fetchImpl,
        1_000,
        AEC_CAPTURE_URL,
      ),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful aec-capture POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ armed: true });
    };
    await expect(
      postAecLoopJsonWithFetch(
        AEC_CAPTURE_URL,
        { arm: true },
        fetchImpl,
        1_000,
        AEC_CAPTURE_URL,
      ),
    ).resolves.toEqual({ armed: true });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("aborts a stalled far-end audioUrl GET at its own deadline", async () => {
    await expect(
      getAecLoopAudioUrlWithFetch(AUDIO_URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed audioUrl GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 404, statusText: "Not Found" });
    await expect(
      getAecLoopAudioUrlWithFetch(AUDIO_URL, fetchImpl, 1_000),
    ).rejects.toThrow("audioUrl -> 404");
  });

  it("uses the injected fetch for a successful audioUrl GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const bytes = await getAecLoopAudioUrlWithFetch(AUDIO_URL, fetchImpl, 1_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(bytes.byteLength).toBe(3);
  });

  it("aborts a stalled TTS POST at its own deadline", async () => {
    await expect(
      postAecLoopTtsWithFetch(TTS_URL, { text: "hi" }, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed TTS POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    await expect(
      postAecLoopTtsWithFetch(TTS_URL, { text: "hi" }, fetchImpl, 1_000),
    ).rejects.toThrow("tts -> 503");
  });

  it("uses the injected fetch for a successful TTS POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(new Uint8Array([9]), { status: 200 });
    };
    const bytes = await postAecLoopTtsWithFetch(
      TTS_URL,
      { text: "hi" },
      fetchImpl,
      1_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(bytes.byteLength).toBe(1);
  });

  it("aborts a stalled near-end audio GET at its own deadline", async () => {
    await expect(
      getAecLoopNearEndAudioWithFetch(NEAR_URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed near-end audio GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 502, statusText: "Bad Gateway" });
    await expect(
      getAecLoopNearEndAudioWithFetch(NEAR_URL, fetchImpl, 1_000),
    ).rejects.toThrow("nearEndAudioUrl -> 502");
  });

  it("uses the injected fetch for a successful near-end audio GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(new Uint8Array([4, 5]), { status: 200 });
    };
    const bytes = await getAecLoopNearEndAudioWithFetch(
      NEAR_URL,
      fetchImpl,
      1_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(bytes.byteLength).toBe(2);
  });
});

