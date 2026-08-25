/**
 * Deterministic unit tests verifying that Google Meet transcript reports
 * preserve complete Unicode-safe content.
 */

import { describe, expect, it } from "vitest";
import { summarizeTranscript } from "./meet.js";
import type { GoogleMeetTranscript } from "./types.js";

describe("Google Meet transcript surrogate safety", () => {
  it("preserves complete content beyond the former 500-character boundary", () => {
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
    expect(result.summary).toBe(unpunctuatedText);
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

  it("preserves every qualifying key point and action item", () => {
    const transcript = Array.from({ length: 12 }, (_, index) => ({
      id: `entry_${index}`,
      name: `entry_${index}`,
      text: `Action item ${index}: owner will follow up with the complete result.`,
      startTime: "2026-07-04T14:00:00.000Z",
      endTime: "2026-07-04T14:01:00.000Z",
    }));

    const result = summarizeTranscript(transcript);
    expect(result.keyPoints).toHaveLength(12);
    expect(result.actionItems).toHaveLength(12);
    expect(result.summary).toContain("Action item 11");
  });
});
