/**
 * Deterministic contracts for the on-device AEC evidence harness: hash-trigger
 * parsing and owned response-reader cancellation. Device acoustics remain a
 * real-target evidence requirement.
 */

import { describe, expect, it, vi } from "vitest";
import { parseAecLoopHash, readAudioBody } from "./aec-loop-harness";

function makeStalledAudioResponse() {
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const cancel = vi.fn(async (_reason?: unknown) => undefined);
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          markReadStarted?.();
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { status: 200 },
  );
  return { cancel, readStarted, response };
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

describe("AEC audio response-body ownership", () => {
  it("cancels its reader when a response body exceeds the local deadline", async () => {
    const stalled = makeStalledAudioResponse();
    const result = readAudioBody(
      stalled.response,
      "local TTS",
      new AbortController().signal,
      20,
    );
    await stalled.readStarted;

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(stalled.cancel.mock.calls[0][0]).toMatchObject({
      name: "TimeoutError",
    });
  });

  it("cancels its reader with the caller reason after headers", async () => {
    const stalled = makeStalledAudioResponse();
    const controller = new AbortController();
    const reason = new DOMException("loop stopped", "AbortError");
    const result = readAudioBody(
      stalled.response,
      "external audio",
      controller.signal,
      1_000,
    );
    await stalled.readStarted;
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(stalled.cancel).toHaveBeenCalledWith(reason);
  });

  it("combines fragmented audio bytes without cancelling a healthy body", async () => {
    const cancel = vi.fn(async (_reason?: unknown) => undefined);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1, 2));
          controller.enqueue(Uint8Array.of(3, 4));
          controller.close();
        },
        cancel,
      }),
      { status: 200 },
    );

    const bytes = await readAudioBody(
      response,
      "healthy audio",
      new AbortController().signal,
      1_000,
    );

    expect(new Uint8Array(bytes)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(cancel).not.toHaveBeenCalled();
  });
});
