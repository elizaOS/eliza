/**
 * Unit tests for surrogate-pair safe meeting transcript summary truncation.
 *
 * Verifies that summarizeTranscript cleanly handles long continuous text without
 * splitting UTF-16 surrogate pairs into orphaned high/low surrogate code units.
 */

import { describe, expect, it } from "vitest";
import { summarizeTranscript, type GoogleMeetTranscript } from "./meet.ts";

describe("summarizeTranscript surrogate safety", () => {
  it("preserves surrogate pairs when falling back to raw text slice", () => {
    // "x" (1 char) + "🔥" (2 chars * 300 = 600 chars) -> bisects at 500
    const longEmojiText = "x" + "🔥".repeat(300);
    const fakeTranscript: GoogleMeetTranscript = {
      name: "conferenceRecords/conf_1/transcripts/trans_1",
      documentTitle: "Transcript",
      text: longEmojiText,
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
    };

    const result = summarizeTranscript([fakeTranscript]);
    expect(result.summary.length).toBe(499);
    for (const char of result.summary) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
