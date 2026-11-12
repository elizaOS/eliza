/**
 * iOS native llama wire behavior that runs in Bun: the context window comes
 * from what the native load admitted, an abandoned generation tells the host
 * to stop decoding, and dictation PCM travels as base64 fp32.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { encodeIosAsrPcm, loadedNativeContextSize } from "./bridge.ts";
import { dispatchIosNativeGeneration } from "./native-generation.ts";

const completeResult = { text: "ok", incomplete: false };

function generationArgs(overrides: {
  invoke?: () => Promise<unknown>;
  cancel?: () => Promise<unknown>;
  signal?: AbortSignal;
}) {
  return {
    provider: "ios-native-llama",
    model: "test-model",
    contextWindowTokens: 4096,
    requestedMaxTokens: 16,
    request: {
      context_id: 7,
      prompt: "hello",
      temperature: 0.2,
      top_p: 0.95,
      top_k: 40,
      stop: [],
    },
    invoke: overrides.invoke ?? (async () => completeResult),
    cancel: overrides.cancel,
    signal: overrides.signal,
  };
}

describe("loadedNativeContextSize", () => {
  it("uses the context size the native load admitted", () => {
    expect(
      loadedNativeContextSize({
        context_id: 1,
        context_size: 2048,
        requestedContextSize: 4096,
      }),
    ).toBe(2048);
  });

  it("rejects a load result without a context size", () => {
    expect(() => loadedNativeContextSize({ context_id: 1 })).toThrow(
      /did not report its context size/,
    );
  });

  it("sizes an unbounded native request by the admitted window", async () => {
    const invoke = vi.fn(async (_request: { max_tokens: number }) => {
      return completeResult;
    });
    await dispatchIosNativeGeneration({
      ...generationArgs({}),
      contextWindowTokens: loadedNativeContextSize({ context_size: 2048 }),
      requestedMaxTokens: undefined,
      invoke,
    });
    expect(invoke.mock.calls[0]?.[0].max_tokens).toBe(2048);
  });
});

describe("dispatchIosNativeGeneration cancellation", () => {
  it("sends llama_cancel and rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const pending = dispatchIosNativeGeneration(
      generationArgs({
        invoke: () => new Promise(() => {}),
        cancel,
        signal: controller.signal,
      }),
    );
    controller.abort(new Error("user stopped"));
    await expect(pending).rejects.toThrow("user stopped");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not start the native call when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn(async () => completeResult);
    const cancel = vi.fn(async () => undefined);
    await expect(
      dispatchIosNativeGeneration(
        generationArgs({ invoke, cancel, signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("sends llama_cancel when the host call times out", async () => {
    const cancel = vi.fn(async () => undefined);
    await expect(
      dispatchIosNativeGeneration(
        generationArgs({
          invoke: async () => {
            throw new Error("Native iOS host call llama_generate timed out");
          },
          cancel,
        }),
      ),
    ).rejects.toThrow(/timed out/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the original error when the cancel itself fails", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("bridge gone");
    });
    await expect(
      dispatchIosNativeGeneration(
        generationArgs({
          invoke: async () => {
            throw new Error("decode failed");
          },
          cancel,
        }),
      ),
    ).rejects.toThrow("decode failed");
  });

  it("does not cancel a generation that finished", async () => {
    const cancel = vi.fn(async () => undefined);
    await expect(
      dispatchIosNativeGeneration(generationArgs({ cancel })),
    ).resolves.toBe("ok");
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("encodeIosAsrPcm", () => {
  it("sends little-endian fp32 samples as base64", () => {
    const pcm = [0, 0.5, -1, 0.25];
    const bytes = Buffer.from(encodeIosAsrPcm(pcm, 16000), "base64");
    expect(bytes.byteLength).toBe(pcm.length * 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(pcm.map((_, i) => view.getFloat32(i * 4, true))).toEqual(pcm);
  });

  it("refuses a recording that would not fit in one host frame", () => {
    const tooLong = new Array(4 * 1024 * 1024).fill(0);
    expect(() => encodeIosAsrPcm(tooLong, 16000)).toThrow(
      /too long for on-device transcription \(limit about 184 s\)/,
    );
  });
});
