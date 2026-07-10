/**
 * Unit coverage for the Whisper verbose_json timestamp parser (#14806). Pure
 * function — proves seconds→ms conversion, fail-closed J3 validation, and that
 * a plain `{text}` payload yields no timestamp keys —
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
    expect(parsed.invalidFields).toEqual([]);
  });

  it("yields no timestamp keys for a plain {text} payload (server ignored the format)", () => {
    const parsed = parseWhisperTimestamps({ text: "hello" });
    expect("segments" in parsed).toBe(false);
    expect("words" in parsed).toBe(false);
    expect(parsed.invalidFields).toEqual([]);
  });

  it("marks a whole field invalid instead of returning a partial span set (J3)", () => {
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
    expect(parsed.invalidFields).toEqual(["segments", "words"]);
    expect("segments" in parsed).toBe(false);
    expect("words" in parsed).toBe(false);
  });

  it("omits a key entirely when every entry in that array is malformed", () => {
    const parsed = parseWhisperTimestamps({
      text: "x",
      segments: [{ text: "bad", start: 3, end: 1 }],
      words: [],
    });
    expect("segments" in parsed).toBe(false);
    expect("words" in parsed).toBe(false);
    expect(parsed.invalidFields).toEqual(["segments"]);
  });

  it("marks a present non-array timestamp field invalid", () => {
    const parsed = parseWhisperTimestamps({
      text: "x",
      segments: { text: "not-an-array", start: 0, end: 1 },
    });
    expect(parsed.invalidFields).toEqual(["segments"]);
    expect("segments" in parsed).toBe(false);
  });

  it("accepts a zero-length span (start === end) as valid", () => {
    const parsed = parseWhisperTimestamps({
      words: [{ word: "uh", start: 1.0, end: 1.0 }],
    });
    expect(parsed.words).toEqual([{ text: "uh", startMs: 1000, endMs: 1000 }]);
    expect(parsed.invalidFields).toEqual([]);
  });
});
