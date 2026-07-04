/**
 * Unit coverage for the transcript-session accumulator over PCM16 WAV frames.
 * Pure function, no mic.
 */
import { describe, expect, it } from "vitest";
import { TranscriptSessionAccumulator } from "./transcript-session";

/** Build a valid mono PCM16 WAV with `nSamples` (zeroed) samples. */
function makeWav(nSamples: number, sampleRate = 16000): Uint8Array {
  const dataBytes = nSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

describe("TranscriptSessionAccumulator (wall-clock, no audio)", () => {
  it("folds utterances into contiguous, session-relative segments", () => {
    const acc = new TranscriptSessionAccumulator(1000);
    acc.addFinal("hello there", 2000); // 0..1000
    acc.addFinal("how are you", 3500, { speakerLabel: "Alice" }); // 1000..2500
    expect(acc.count).toBe(2);
    const segs = acc.build();
    expect(
      segs.map((s) => [s.startMs, s.endMs, s.text, s.speakerLabel]),
    ).toEqual([
      [0, 1000, "hello there", undefined],
      [1000, 2500, "how are you", "Alice"],
    ]);
    expect(acc.buildAudioWav()).toBeNull();
  });

  it("ignores empty/whitespace utterances", () => {
    const acc = new TranscriptSessionAccumulator(0);
    acc.addFinal("   ", 500);
    acc.addFinal("", 600);
    expect(acc.count).toBe(0);
  });
});

describe("TranscriptSessionAccumulator (audio-aligned timeline)", () => {
  it("uses audio duration for the span, offsets words, concatenates the WAV", () => {
    const acc = new TranscriptSessionAccumulator(1000);
    // 16000 samples @ 16kHz = 1000ms.
    acc.addFinal("hello world", 99999, {
      audioWav: makeWav(16000),
      words: [
        { text: "hello", startMs: 0, endMs: 400 },
        { text: "world", startMs: 500, endMs: 1000 },
      ],
    });
    // 8000 samples @ 16kHz = 500ms → second segment [1000,1500].
    acc.addFinal("again", 99999, {
      audioWav: makeWav(8000),
      words: [{ text: "again", startMs: 0, endMs: 500 }],
    });

    const segs = acc.build();
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 1000],
      [1000, 1500],
    ]);
    // Words offset into session time.
    expect(segs[0].words).toEqual([
      { text: "hello", startMs: 0, endMs: 400 },
      { text: "world", startMs: 500, endMs: 1000 },
    ]);
    expect(segs[1].words).toEqual([
      { text: "again", startMs: 1000, endMs: 1500 },
    ]);

    // One concatenated session WAV of 24000 samples (1500ms).
    const wav = acc.buildAudioWav();
    expect(wav).not.toBeNull();
    const v = new DataView(
      (wav as Uint8Array).buffer,
      (wav as Uint8Array).byteOffset,
    );
    expect(v.getUint32(24, true)).toBe(16000); // sample rate
    expect((wav as Uint8Array).byteLength).toBe(44 + 24000 * 2);
  });
});
