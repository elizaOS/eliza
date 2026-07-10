/**
 * Covers the audio-PII span production module (#14807): locating text-PII
 * verdicts inside a timed word stream (multi-word, fused-token, repeated, and
 * unlocatable spans) and the pad/clamp/merge math (overlaps, adjacency,
 * containment, padding at file edges, empty input, out-of-order words). The
 * fused-token vector is a REAL word list captured from a live
 * faster-whisper `timestamp_granularities=word` transcription of a Kokoro
 * TTS fixture — leading spaces, trailing punctuation, digits fused into one
 * ASR word ("5550123.") — not a synthetic idealization.
 */

import { describe, expect, it } from "vitest";
import {
  buildAudioRedactionSpans,
  DEFAULT_REDACTION_PAD_MS,
  matchPiiSpansToWords,
  mergeRedactionSpans,
  normalizeSpokenText,
  RedactionSpanError,
} from "./audio-redaction";
import type { TranscriptWord } from "./transcripts";

/** Word list captured from a LIVE faster-whisper word-timestamp run. */
const LIVE_WHISPER_WORDS: TranscriptWord[] = [
  { text: " This", startMs: 0, endMs: 540 },
  { text: " is", startMs: 540, endMs: 820 },
  { text: " a", startMs: 820, endMs: 960 },
  { text: " team", startMs: 960, endMs: 1180 },
  { text: " meeting", startMs: 1180, endMs: 1480 },
  { text: " recording.", startMs: 1480, endMs: 2000 },
  { text: " My", startMs: 2580, endMs: 2680 },
  { text: " name", startMs: 2680, endMs: 2940 },
  { text: " is", startMs: 2940, endMs: 3200 },
  { text: " John", startMs: 3200, endMs: 3520 },
  { text: " Smith", startMs: 3520, endMs: 3880 },
  { text: " and", startMs: 3880, endMs: 4200 },
  { text: " my", startMs: 4200, endMs: 4440 },
  { text: " phone", startMs: 4440, endMs: 4680 },
  { text: " number", startMs: 4680, endMs: 4960 },
  { text: " is", startMs: 4960, endMs: 5540 },
  { text: " 5550123.", startMs: 5540, endMs: 7300 },
  { text: " The", startMs: 8060, endMs: 8120 },
  { text: " weather", startMs: 8120, endMs: 8380 },
  { text: " today", startMs: 8380, endMs: 8740 },
  { text: " is", startMs: 8740, endMs: 9000 },
  { text: " sunny", startMs: 9000, endMs: 9200 },
] as const as TranscriptWord[];

const LIVE_DURATION_MS = 11_875;

describe("normalizeSpokenText", () => {
  it("lowercases and strips separators, keeping letters and digits", () => {
    expect(normalizeSpokenText(" 555-0123. ")).toBe("5550123");
    expect(normalizeSpokenText("John  Smith!")).toBe("johnsmith");
    expect(normalizeSpokenText("--- ...")).toBe("");
  });
});

describe("matchPiiSpansToWords", () => {
  it("locates a multi-word name across ASR word boundaries", () => {
    const { matches, unmatched } = matchPiiSpansToWords(LIVE_WHISPER_WORDS, [
      { text: "John Smith", label: "PERSON_1" },
    ]);
    expect(unmatched).toEqual([]);
    expect(matches).toEqual([
      { startMs: 3200, endMs: 3880, labels: ["PERSON_1"] },
    ]);
  });

  it("locates spaced PII inside a fused ASR word (555 0123 → '5550123.')", () => {
    const { matches, unmatched } = matchPiiSpansToWords(LIVE_WHISPER_WORDS, [
      { text: "555 0123" },
    ]);
    expect(unmatched).toEqual([]);
    expect(matches).toEqual([{ startMs: 5540, endMs: 7300 }]);
  });

  it("windows EVERY occurrence of a repeated PII span", () => {
    const words: TranscriptWord[] = [
      { text: "Alice", startMs: 0, endMs: 400 },
      { text: "called", startMs: 400, endMs: 800 },
      { text: "Alice", startMs: 800, endMs: 1200 },
    ];
    const { matches } = matchPiiSpansToWords(words, [{ text: "alice" }]);
    expect(matches).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 800, endMs: 1200 },
    ]);
  });

  it("returns unlocatable spans in unmatched (fail-closed input)", () => {
    const { matches, unmatched } = matchPiiSpansToWords(LIVE_WHISPER_WORDS, [
      { text: "Jane Doe", label: "PERSON_2" },
      { text: "   " },
    ]);
    expect(matches).toEqual([]);
    expect(unmatched).toEqual([
      { text: "Jane Doe", label: "PERSON_2" },
      { text: "   " },
    ]);
  });

  it("tolerates out-of-order word input by sorting on time", () => {
    const shuffled = [...LIVE_WHISPER_WORDS].reverse();
    const { matches, unmatched } = matchPiiSpansToWords(shuffled, [
      { text: "John Smith" },
    ]);
    expect(unmatched).toEqual([]);
    expect(matches).toEqual([{ startMs: 3200, endMs: 3880 }]);
  });

  it("throws on words with non-finite or inverted timings", () => {
    expect(() =>
      matchPiiSpansToWords(
        [{ text: "x", startMs: Number.NaN, endMs: 1 }],
        [{ text: "x" }],
      ),
    ).toThrow(RedactionSpanError);
    expect(() =>
      matchPiiSpansToWords(
        [{ text: "x", startMs: 100, endMs: 50 }],
        [{ text: "x" }],
      ),
    ).toThrow(RedactionSpanError);
  });
});

describe("mergeRedactionSpans", () => {
  const options = { durationMs: 10_000, padMs: 100 };

  it("returns [] for empty input", () => {
    expect(mergeRedactionSpans([], options)).toEqual([]);
  });

  it("pads both sides and rounds to integer ms", () => {
    expect(
      mergeRedactionSpans([{ startMs: 1000.4, endMs: 2000.6 }], options),
    ).toEqual([{ startMs: 900, endMs: 2101 }]);
  });

  it("merges overlapping windows", () => {
    expect(
      mergeRedactionSpans(
        [
          { startMs: 1000, endMs: 2000 },
          { startMs: 1900, endMs: 2500 },
        ],
        { durationMs: 10_000, padMs: 0 },
      ),
    ).toEqual([{ startMs: 1000, endMs: 2500 }]);
  });

  it("merges exactly adjacent windows", () => {
    expect(
      mergeRedactionSpans(
        [
          { startMs: 1000, endMs: 2000 },
          { startMs: 2000, endMs: 3000 },
        ],
        { durationMs: 10_000, padMs: 0 },
      ),
    ).toEqual([{ startMs: 1000, endMs: 3000 }]);
  });

  it("collapses a contained window into its container, unioning labels", () => {
    expect(
      mergeRedactionSpans(
        [
          { startMs: 1000, endMs: 4000, labels: ["PERSON_1"] },
          { startMs: 2000, endMs: 3000, labels: ["PHONE_1"] },
        ],
        { durationMs: 10_000, padMs: 0 },
      ),
    ).toEqual([
      { startMs: 1000, endMs: 4000, labels: ["PERSON_1", "PHONE_1"] },
    ]);
  });

  it("keeps disjoint windows separate and sorted", () => {
    expect(
      mergeRedactionSpans(
        [
          { startMs: 5000, endMs: 6000 },
          { startMs: 1000, endMs: 2000 },
        ],
        { durationMs: 10_000, padMs: 0 },
      ),
    ).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it("bridges windows closer than mergeGapMs", () => {
    expect(
      mergeRedactionSpans(
        [
          { startMs: 1000, endMs: 2000 },
          { startMs: 2100, endMs: 3000 },
        ],
        { durationMs: 10_000, padMs: 0, mergeGapMs: 150 },
      ),
    ).toEqual([{ startMs: 1000, endMs: 3000 }]);
  });

  it("clamps padding at the file start (never negative)", () => {
    expect(
      mergeRedactionSpans([{ startMs: 30, endMs: 500 }], {
        durationMs: 10_000,
        padMs: 100,
      }),
    ).toEqual([{ startMs: 0, endMs: 600 }]);
  });

  it("clamps padding at the file end (never past duration)", () => {
    expect(
      mergeRedactionSpans([{ startMs: 9950, endMs: 9990 }], {
        durationMs: 10_000,
        padMs: 100,
      }),
    ).toEqual([{ startMs: 9850, endMs: 10_000 }]);
  });

  it("drops windows entirely past the end of the audio", () => {
    expect(
      mergeRedactionSpans([{ startMs: 10_500, endMs: 11_000 }], {
        durationMs: 10_000,
        padMs: 100,
      }),
    ).toEqual([]);
  });

  it("skips the upper clamp when durationMs is 0 (unknown)", () => {
    expect(
      mergeRedactionSpans([{ startMs: 10_500, endMs: 11_000 }], {
        durationMs: 0,
        padMs: 0,
      }),
    ).toEqual([{ startMs: 10_500, endMs: 11_000 }]);
  });

  it("throws on malformed spans instead of dropping them silently", () => {
    expect(() =>
      mergeRedactionSpans([{ startMs: Number.NaN, endMs: 1 }], options),
    ).toThrow(RedactionSpanError);
    expect(() =>
      mergeRedactionSpans([{ startMs: 500, endMs: 100 }], options),
    ).toThrow(RedactionSpanError);
    expect(() =>
      mergeRedactionSpans([{ startMs: 0, endMs: 1 }], {
        durationMs: Number.NaN,
      }),
    ).toThrow(RedactionSpanError);
  });

  it("applies the documented default padding", () => {
    const [span] = mergeRedactionSpans([{ startMs: 1000, endMs: 2000 }], {
      durationMs: 10_000,
    });
    expect(span).toEqual({
      startMs: 1000 - DEFAULT_REDACTION_PAD_MS,
      endMs: 2000 + DEFAULT_REDACTION_PAD_MS,
    });
  });
});

describe("buildAudioRedactionSpans (end-to-end on the live word vector)", () => {
  it("derives merged executor windows and surfaces unlocatable spans", () => {
    const plan = buildAudioRedactionSpans(
      LIVE_WHISPER_WORDS,
      [
        { text: "John Smith", label: "PERSON_1" },
        { text: "555 0123", label: "PHONE_1" },
        { text: "Jane Doe", label: "PERSON_2" },
      ],
      { durationMs: LIVE_DURATION_MS, padMs: 120 },
    );
    // Jane Doe is not in the audio — the caller must fail the job on this.
    expect(plan.unmatched).toEqual([{ text: "Jane Doe", label: "PERSON_2" }]);
    expect(plan.spans).toEqual([
      { startMs: 3080, endMs: 4000, labels: ["PERSON_1"] },
      { startMs: 5420, endMs: 7420, labels: ["PHONE_1"] },
    ]);
    // Windows sit strictly inside the audio and do not overlap.
    for (const span of plan.spans) {
      expect(span.startMs).toBeGreaterThanOrEqual(0);
      expect(span.endMs).toBeLessThanOrEqual(LIVE_DURATION_MS);
    }
    expect(plan.spans[0].endMs).toBeLessThan(plan.spans[1].startMs);
  });
});
