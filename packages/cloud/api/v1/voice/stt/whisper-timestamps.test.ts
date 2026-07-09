/**
 * Unit coverage for the Whisper verbose_json timestamp parser (#14806). Pure
 * function — proves seconds→ms conversion, the per-entry J3 validation (drop,
 * never coerce), and that a plain `{text}` payload yields no timestamp keys —
 * without booting the route's billing/service graph. The live round-trip
 * against the hosted faster-whisper belongs to voice-kokoro-whisper-live.
 */

import { describe, expect, it } from "bun:test";
import { parseWhisperTimestamps } from "./whisper-timestamps";

describe("parseWhisperTimestamps (#14806)", () => {
  it("converts OpenAI verbose_json segments and words from seconds to ms", () => {
    const parsed = parseWhisperTimestamps({
      text: "hello there world",
      segments: [
        { id: 0, text: " hello there", start: 0.0, end: 1.28 },
        { id: 1, text: " world", start: 1.5, end: 2.0 },
      ],
      words: [
        { word: "hello", start: 0.0, end: 0.62 },
        { word: "there", start: 0.7, end: 1.28 },
        { word: "world", start: 1.5, end: 2.0 },
      ],
    });
    expect(parsed.segments).toEqual([
      { text: "hello there", startMs: 0, endMs: 1280 },
      { text: "world", startMs: 1500, endMs: 2000 },
    ]);
    expect(parsed.words).toEqual([
      { text: "hello", startMs: 0, endMs: 620 },
      { text: "there", startMs: 700, endMs: 1280 },
      { text: "world", startMs: 1500, endMs: 2000 },
    ]);
    expect(parsed.dropped).toBe(0);
  });

  it("yields no timestamp keys for a plain {text} payload (server ignored the format)", () => {
    const parsed = parseWhisperTimestamps({ text: "hello" });
    expect("segments" in parsed).toBe(false);
    expect("words" in parsed).toBe(false);
    expect(parsed.dropped).toBe(0);
  });

  it("drops malformed entries instead of coercing them (J3)", () => {
    const parsed = parseWhisperTimestamps({
      segments: [
        { text: "ok", start: 0, end: 1 },
        { text: "", start: 1, end: 2 }, // empty text
        { text: "inverted", start: 5, end: 2 }, // end < start
        { text: "nan", start: Number.NaN, end: 2 }, // non-finite
        { text: "negative", start: -1, end: 2 }, // negative
        "not-an-object",
        { text: "stringy", start: "0", end: "1" }, // wrong types
      ],
      words: [{ word: "fine", start: 0.1, end: 0.2 }, { word: "no-times" }],
    });
    expect(parsed.segments).toEqual([{ text: "ok", startMs: 0, endMs: 1000 }]);
    expect(parsed.words).toEqual([{ text: "fine", startMs: 100, endMs: 200 }]);
    expect(parsed.dropped).toBe(7);
  });

  it("omits a key entirely when every entry in that array is malformed", () => {
    const parsed = parseWhisperTimestamps({
      text: "x",
      segments: [{ text: "bad", start: 3, end: 1 }],
      words: [],
    });
    expect("segments" in parsed).toBe(false);
    expect("words" in parsed).toBe(false);
    expect(parsed.dropped).toBe(1);
  });

  it("tolerates a non-object payload", () => {
    expect(parseWhisperTimestamps(null)).toEqual({ dropped: 0 });
    expect(parseWhisperTimestamps("text")).toEqual({ dropped: 0 });
    expect(parseWhisperTimestamps(42)).toEqual({ dropped: 0 });
  });

  it("accepts a zero-length span (start === end) as valid", () => {
    const parsed = parseWhisperTimestamps({
      words: [{ word: "uh", start: 1.0, end: 1.0 }],
    });
    expect(parsed.words).toEqual([{ text: "uh", startMs: 1000, endMs: 1000 }]);
    expect(parsed.dropped).toBe(0);
  });
});
