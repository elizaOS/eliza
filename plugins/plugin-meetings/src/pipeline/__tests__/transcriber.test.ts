import { Buffer } from "node:buffer";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeModelAsrBackend } from "../transcriber";
import { float32ToWav } from "../wav";

interface CapturedParams {
  audio: Buffer;
  mimeType: string;
  audioUrl: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

function runtimeWith(useModel: ReturnType<typeof vi.fn>): IAgentRuntime {
  return { useModel } as unknown as IAgentRuntime;
}

const WAV = float32ToWav(new Float32Array(1600));

describe("RuntimeModelAsrBackend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls TRANSCRIPTION with audio Buffer + data-URL + prompt/language continuity", async () => {
    const useModel = vi.fn().mockResolvedValue("  hello from the meeting  ");
    const backend = new RuntimeModelAsrBackend(runtimeWith(useModel));

    const result = await backend.transcribe(WAV, {
      language: "en",
      prompt: "previously confirmed text",
    });
    expect(result).toEqual({ text: "hello from the meeting" });

    expect(useModel).toHaveBeenCalledTimes(1);
    const [modelType, params] = useModel.mock.calls[0] as [
      string,
      CapturedParams,
    ];
    expect(modelType).toBe("TRANSCRIPTION");
    expect(Buffer.isBuffer(params.audio)).toBe(true);
    expect(params.mimeType).toBe("audio/wav");
    expect(params.audioUrl).toBe(
      `data:audio/wav;base64,${WAV.toString("base64")}`,
    );
    expect(params.language).toBe("en");
    expect(params.prompt).toBe("previously confirmed text");
  });

  it("maps blank-audio / non-speech markers and empty output to silence", async () => {
    const useModel = vi.fn();
    const backend = new RuntimeModelAsrBackend(runtimeWith(useModel));
    for (const raw of [
      "",
      "   ",
      "[BLANK_AUDIO]",
      " [ BLANK_AUDIO ] ",
      "(silence)",
      "[inaudible]",
    ]) {
      useModel.mockResolvedValueOnce(raw);
      expect(await backend.transcribe(WAV, {})).toEqual({ text: "" });
    }
  });

  it("retries transient failures with exponential backoff, then succeeds", async () => {
    const useModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("third time lucky");
    const backend = new RuntimeModelAsrBackend(runtimeWith(useModel), {
      retryDelayMs: 100,
    });

    const promise = backend.transcribe(WAV, {});
    await vi.advanceTimersByTimeAsync(100); // first backoff
    await vi.advanceTimersByTimeAsync(200); // second backoff (doubled)
    expect(await promise).toEqual({ text: "third time lucky" });
    expect(useModel).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting retries", async () => {
    const useModel = vi.fn().mockRejectedValue(new Error("provider down"));
    const backend = new RuntimeModelAsrBackend(runtimeWith(useModel), {
      maxRetries: 2,
      retryDelayMs: 10,
    });
    const promise = backend.transcribe(WAV, {});
    const outcome = promise.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(10 + 20);
    expect(((await outcome) as Error).message).toBe("provider down");
    expect(useModel).toHaveBeenCalledTimes(3);
  });

  it("does not retry after an abort", async () => {
    const controller = new AbortController();
    const useModel = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted mid-call");
    });
    const backend = new RuntimeModelAsrBackend(runtimeWith(useModel));
    await expect(
      backend.transcribe(WAV, { signal: controller.signal }),
    ).rejects.toThrow("aborted mid-call");
    expect(useModel).toHaveBeenCalledTimes(1);
  });
});
