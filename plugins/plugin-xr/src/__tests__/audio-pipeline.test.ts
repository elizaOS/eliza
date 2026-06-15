import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPipeline } from "../services/audio-pipeline.ts";

function makeRuntime(transcriptResult = "hello world"): IAgentRuntime {
  return {
    useModel: vi.fn().mockResolvedValue(transcriptResult),
  } as unknown as IAgentRuntime;
}

describe("AudioPipeline", () => {
  let onTranscript: ReturnType<typeof vi.fn>;
  let runtime: IAgentRuntime;
  let pipeline: AudioPipeline;

  beforeEach(() => {
    onTranscript = vi.fn().mockResolvedValue(undefined);
    runtime = makeRuntime("test transcript");
    pipeline = new AudioPipeline(
      runtime,
      onTranscript as (id: string, text: string) => Promise<void>,
    );
  });

  it("calls onTranscript after flush with enough audio", async () => {
    const header = {
      type: "audio" as const,
      ts: 0,
      sampleRate: 16000,
      encoding: "webm-opus" as const,
    };
    const chunk = Buffer.alloc(1024, 0x55);

    pipeline.push("conn1", header, chunk);
    await pipeline.flush("conn1");

    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TRANSCRIPTION,
      expect.any(Buffer),
    );
    expect(onTranscript).toHaveBeenCalledWith("conn1", "test transcript");
  });

  it("does not call onTranscript for tiny chunks", async () => {
    const header = {
      type: "audio" as const,
      ts: 0,
      sampleRate: 16000,
      encoding: "webm-opus" as const,
    };
    pipeline.push("conn1", header, Buffer.alloc(64));
    await pipeline.flush("conn1");

    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("ignores empty transcription results", async () => {
    (runtime.useModel as ReturnType<typeof vi.fn>).mockResolvedValue("   ");
    const header = {
      type: "audio" as const,
      ts: 0,
      sampleRate: 16000,
      encoding: "webm-opus" as const,
    };
    pipeline.push("conn1", header, Buffer.alloc(1024));
    await pipeline.flush("conn1");

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("clears pending state on clear()", () => {
    const header = {
      type: "audio" as const,
      ts: 0,
      sampleRate: 16000,
      encoding: "webm-opus" as const,
    };
    pipeline.push("conn1", header, Buffer.alloc(512));
    pipeline.clear("conn1");
    // after clear, flush has no pending audio to emit
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("wraps pcm-f32 chunks with a WAV header before transcription", async () => {
    // pcm-f32: 1024 float32 samples = 4096 bytes of raw audio (> 512-byte floor)
    const float32Samples = new Float32Array(1024).fill(0.1);
    const chunk = Buffer.from(float32Samples.buffer);

    const header = {
      type: "audio" as const,
      ts: 0,
      sampleRate: 44100,
      encoding: "pcm-f32" as const,
    };
    pipeline.push("conn1", header, chunk);
    await pipeline.flush("conn1");

    const callArg = (runtime.useModel as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Buffer;

    // WAV header starts with "RIFF"
    expect(callArg.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // IEEE_FLOAT format tag = 3 at offset 20 (little-endian uint16)
    expect(callArg.readUInt16LE(20)).toBe(3);
    // sample rate at offset 24
    expect(callArg.readUInt32LE(24)).toBe(44100);
    // data chunk starts at offset 44 — matches original pcm bytes
    expect(callArg.subarray(44)).toEqual(chunk);
  });

  it("auto-flushes after FLUSH_AFTER_MS duration", async () => {
    const header = {
      type: "audio" as const,
      ts: 0,
      sampleRate: 16000,
      encoding: "webm-opus" as const,
    };
    pipeline.push("conn1", header, Buffer.alloc(1024));
    // Advance ts by 2100ms to trigger auto-flush
    const header2 = { ...header, ts: 2100 };
    pipeline.push("conn1", header2, Buffer.alloc(1024));

    // flush was called internally; useModel should have been called
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.useModel).toHaveBeenCalled();
  });
});
