/**
 * RuntimeModelAsrBackend — the ASR seam that WAV-encodes a PCM window and routes
 * it through `runtime.useModel(TRANSCRIPTION)`, returning text plus word
 * timings. Deterministic: the model is a capturing fake.
 */
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
  transcriptionPurpose?: "interim" | "final";
  billing?: { billable: boolean; reason?: string };
  signal?: AbortSignal;
}

function runtimeWith(
  useModel: ReturnType<typeof vi.fn>,
  opts?: {
    localTranscription?: boolean;
    localProvider?: string;
    metadataLocal?: boolean;
  },
): IAgentRuntime {
  return {
    useModel,
    getModelRegistrations: () =>
      opts?.localTranscription
        ? [
            {
              modelType: "TRANSCRIPTION",
              provider: opts.localProvider ?? "eliza-local-inference",
              priority: 0,
              registrationOrder: 0,
              ...(opts.metadataLocal === undefined
                ? {}
                : { metadata: { local: opts.metadataLocal } }),
            },
          ]
        : [],
  } as unknown as IAgentRuntime;
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
    expect(params.transcriptionPurpose).toBe("final");
    expect(params.billing).toEqual({
      billable: true,
      reason: "meeting-final-window",
    });
  });

  it("routes interim LocalAgreement windows to local inference as non-billable", async () => {
    const useModel = vi.fn().mockResolvedValue("partial window");
    const backend = new RuntimeModelAsrBackend(
      runtimeWith(useModel, { localTranscription: true }),
    );

    await expect(
      backend.transcribe(WAV, { purpose: "interim" }),
    ).resolves.toEqual({
      text: "partial window",
    });

    expect(useModel).toHaveBeenCalledTimes(1);
    const [modelType, params, provider] = useModel.mock.calls[0] as [
      string,
      CapturedParams,
      string,
    ];
    expect(modelType).toBe("TRANSCRIPTION");
    expect(provider).toBe("eliza-local-inference");
    expect(params.transcriptionPurpose).toBe("interim");
    expect(params.billing).toEqual({
      billable: false,
      reason: "meeting-local-agreement-overlap",
    });
  });

  it("routes interim LocalAgreement windows to provider-declared local transcription", async () => {
    const useModel = vi.fn().mockResolvedValue("edge transcript");
    const backend = new RuntimeModelAsrBackend(
      runtimeWith(useModel, {
        localTranscription: true,
        localProvider: "acme-edge-asr",
        metadataLocal: true,
      }),
    );

    await expect(
      backend.transcribe(WAV, { purpose: "interim" }),
    ).resolves.toEqual({
      text: "edge transcript",
    });

    expect(useModel).toHaveBeenCalledTimes(1);
    const [, params, provider] = useModel.mock.calls[0] as [
      string,
      CapturedParams,
      string,
    ];
    expect(provider).toBe("acme-edge-asr");
    expect(params.transcriptionPurpose).toBe("interim");
    expect(params.billing?.billable).toBe(false);
  });

  it("skips interim LocalAgreement windows when local inference is unavailable", async () => {
    const useModel = vi.fn(async () => {
      throw new Error("should not route interim windows to hosted STT");
    });
    const backend = new RuntimeModelAsrBackend(
      runtimeWith(useModel, {
        localTranscription: true,
        localProvider: "hosted-stt",
        metadataLocal: false,
      }),
    );

    await expect(
      backend.transcribe(WAV, { purpose: "interim" }),
    ).resolves.toEqual({ text: "" });

    expect(useModel).not.toHaveBeenCalled();
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
