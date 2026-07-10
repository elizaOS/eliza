/** Verifies PCM16 stream validation and the exact RIFF/WAV bytes consumed by codec-less clients. */

import { describe, expect, test } from "bun:test";
import { drainPcm16Stream, pcm16ToWav } from "../pcm16-wav";

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

  test("rejects empty and partial samples", async () => {
    await expect(drainPcm16Stream(stream(), 1024)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
    });
    await expect(drainPcm16Stream(stream([0x01, 0x02, 0x03]), 1024)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
    });
    expect(() => pcm16ToWav(Uint8Array.of(1), 24_000)).toThrow("complete 16-bit samples");
  });

  test("cancels and rejects a response beyond the memory limit", async () => {
    await expect(drainPcm16Stream(stream([0, 1], [2, 3]), 2)).rejects.toMatchObject({
      code: "TTS_PCM_INVALID",
      context: { maxBytes: 2, receivedBytes: 4 },
    });
  });
});
