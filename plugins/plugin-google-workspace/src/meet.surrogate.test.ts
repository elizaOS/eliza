/**
 * Deterministic unit tests verifying that Google Meet transcript summarization
 * never splits UTF-16 surrogate pairs during fallback truncation and sanitizes
 * lone surrogates.
 */

import { describe, expect, it } from "vitest";
import { summarizeTranscript } from "./meet.js";
import type { GoogleMeetTranscript } from "./types.js";

describe("Google Meet transcript surrogate safety", () => {
  it("never splits surrogate pairs at the 500 char fallback truncation boundary", () => {
    // 499 'a's + 🦊 (2 UTF-16 code units across 499-500) + 50 'b's = 551 chars without sentence punctuation
    const unpunctuatedText = `${"a".repeat(499)}🦊${"b".repeat(50)}`;
    const transcript: GoogleMeetTranscript[] = [
      {
        id: "entry_1",
        name: "entry_1",
        text: unpunctuatedText,
        startTime: "2026-07-04T14:00:00.000Z",
        endTime: "2026-07-04T14:01:00.000Z",
      },
    ];

    const result = summarizeTranscript(transcript);
    expect(result.summary.isWellFormed()).toBe(true);
    expect(result.summary.length).toBe(499);
    expect(result.summary).toBe("a".repeat(499));
  });

  it("sanitizes lone surrogates in transcript entries", () => {
    const transcript: GoogleMeetTranscript[] = [
      {
        id: "entry_1",
        name: "entry_1",
        text: `Discussion on topic ${String.fromCharCode(0xd800)} without punctuation`,
        startTime: "2026-07-04T14:00:00.000Z",
        endTime: "2026-07-04T14:01:00.000Z",
      },
    ];

    const result = summarizeTranscript(transcript);
    expect(result.summary.isWellFormed()).toBe(true);
    expect(result.summary).toContain("\uFFFD");
  });

  it("preserves fitting emoji in sentence-based summaries", () => {
    const transcript: GoogleMeetTranscript[] = [
      {
        id: "entry_1",
        name: "entry_1",
        text: "We successfully launched the feature! 🚀 Everything is running smoothly.",
        startTime: "2026-07-04T14:00:00.000Z",
        endTime: "2026-07-04T14:01:00.000Z",
      },
    ];

    const result = summarizeTranscript(transcript);
    expect(result.summary.isWellFormed()).toBe(true);
    expect(result.summary).toContain("🚀");
    expect(result.summary).toBe(
      "We successfully launched the feature! 🚀 Everything is running smoothly."
    );
  });
});
