/** Verifies PCM16 stream validation and the exact RIFF/WAV bytes consumed by codec-less clients. */

import { describe, expect, test } from "bun:test";
import { drainPcm16Stream, drainPcm16ToWav, pcm16ChunksToWav, pcm16ToWav } from "../pcm16-wav";

function stream(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

describe("PCM16 WAV encoding", () => {
  test("preserves streamed samples and writes a canonical mono header", async () => {
    const pcm = await drainPcm16Stream(stream([0x01], [0x02, 0x03, 0x04]), 1024);
    const wav = pcm16ToWav(pcm, 24_000);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(40);
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  test("encodes stream chunks directly into the exact WAV allocation", async () => {
    const wav = await drainPcm16ToWav(stream([0x01, 0x02], [0x03, 0x04]), 1024, 24_000);
    expect(wav.buffer.byteLength).toBe(48);
    expect([...wav.subarray(44)]).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  test("encodes only the bytes exposed by a narrow stream view", async () => {
    const backing = new ArrayBuffer(1024 * 1024);
    const narrow = new Uint8Array(backing, 128, 2);
    narrow.set([0x01, 0x02]);
    const narrowStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(narrow);
        controller.close();
      },
    });

    const wav = await drainPcm16ToWav(narrowStream, 2, 24_000);
    expect(wav.buffer.byteLength).toBe(46);
    expect([...wav.subarray(44)]).toEqual([0x01, 0x02]);
  });

  test("rejects a mismatched chunk byte declaration", () => {
    expect(() => pcm16ChunksToWav([Uint8Array.of(1, 2)], 4, 24_000)).toThrow("declared byte count");
  });

  test("rejects empty and partial samples", async () => {
    await expect(drainPcm16Stream(stream(), 1024)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
    });
    await expect(drainPcm16Stream(stream([0x01, 0x02, 0x03]), 1024)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
    });
    expect(() => pcm16ToWav(Uint8Array.of(1), 24_000)).toThrow("complete 16-bit samples");
  });

  test("rejects invalid drain limits and RIFF byte-rate overflow before reading", async () => {
    await expect(drainPcm16ToWav(stream([0, 1]), 0, 24_000)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
      context: { maxBytes: 0 },
    });
    await expect(drainPcm16ToWav(stream([0, 1]), 1024, 0)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
      context: { sampleRate: 0 },
    });
    expect(() => pcm16ToWav(Uint8Array.of(0, 1), Number.NaN)).toThrow("RIFF uint32");
    expect(() => pcm16ToWav(Uint8Array.of(0, 1), 0x8000_0000)).toThrow("RIFF uint32");
  });

  test("cancels and rejects a response beyond the memory limit", async () => {
    let cancelReason: unknown;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0, 1, 2, 3));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });

    await expect(drainPcm16ToWav(oversized, 2, 24_000)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
      context: { maxBytes: 2, receivedBytes: 4 },
    });
    expect(cancelReason).toBe("PCM16 response exceeded the configured byte limit");
    expect(oversized.locked).toBe(false);
  });

  test("preserves the quota error when stream cancellation fails", async () => {
    const cancelError = new Error("upstream cancel failed");
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0, 1, 2, 3));
      },
      cancel() {
        throw cancelError;
      },
    });

    await expect(drainPcm16ToWav(oversized, 2, 24_000)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
      context: { maxBytes: 2, receivedBytes: 4, cancellationFailed: true },
      cause: cancelError,
    });
    expect(oversized.locked).toBe(false);
  });

  test("releases the reader lock and preserves upstream read failures", async () => {
    const readError = new Error("upstream read failed");
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw readError;
      },
    });

    await expect(drainPcm16ToWav(failing, 1024, 24_000)).rejects.toMatchObject({
      code: "TTS_PCM_READ_FAILED",
      cause: readError,
    });
    expect(failing.locked).toBe(false);
  });
});
