import { describe, expect, it } from "bun:test";
import {
  corpusWer,
  decodeWav,
  encodeWav,
  normalizeWords,
  parseNumberWords,
  resample,
  wordErrors,
} from "./wer";

describe("voice-quality WER", () => {
  it("normalizes case, punctuation, apostrophes and hyphens", () => {
    expect(normalizeWords("In 1997 Hurlbut's career — well-known!")).toEqual([
      "in",
      "1997",
      "hurlbuts",
      "career",
      "well",
      "known",
    ]);
  });

  it("turns spelled numbers into digits on both sides", () => {
    expect(normalizeWords("one hundred sixty nine targets")).toEqual([
      "169",
      "targets",
    ]);
    expect(normalizeWords("nineteen ninety seven")).toEqual(["1997"]);
    expect(normalizeWords("twenty fifteen")).toEqual(["2015"]);
    expect(normalizeWords("three hundred and four indicators")).toEqual([
      "304",
      "indicators",
    ]);
    expect(normalizeWords("two thousand fifteen")).toEqual(["2015"]);
    expect(normalizeWords("12,000 sentences")).toEqual(["12000", "sentences"]);
    expect(
      wordErrors(
        "As of August 2015, there were 169 proposed targets",
        "as of august twenty fifteen there were one hundred sixty-nine proposed targets",
      ).edits,
    ).toBe(0);
  });

  it("leaves non-number words and odd runs alone", () => {
    expect(parseNumberWords(["one", "two"])).toBeNull();
    expect(normalizeWords("one two")).toEqual(["1", "2"]);
    expect(normalizeWords("oh no")).toEqual(["oh", "no"]);
  });

  it("counts substitutions, deletions and insertions", () => {
    const r = wordErrors("the cat sat on the mat", "the cat sat on a big mat");
    expect(r).toEqual({
      edits: 2,
      words: 6,
      substitutions: 1,
      deletions: 0,
      insertions: 1,
    });
    expect(wordErrors("hello world", "").deletions).toBe(2);
    expect(wordErrors("", "")).toMatchObject({ edits: 0, words: 0 });
  });

  it("computes corpus WER over all rows", () => {
    expect(
      corpusWer([wordErrors("a b c d", "a b c d"), wordErrors("a b", "a x")]),
    ).toBeCloseTo(1 / 6);
    expect(corpusWer([])).toBe(0);
  });

  it("round-trips PCM16 WAV and resamples 24 kHz to 16 kHz", () => {
    const tone = new Float32Array(24000);
    for (let i = 0; i < tone.length; i++)
      tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 24000);
    const decoded = decodeWav(encodeWav(tone, 24000));
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.samples.length).toBe(24000);
    expect(
      Math.abs((decoded.samples[100] as number) - (tone[100] as number)),
    ).toBeLessThan(1e-4);
    const down = resample(tone, 24000, 16000);
    expect(down.length).toBe(16000);
    let peak = 0;
    for (const v of down.subarray(100, 15900))
      peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
  });
});
