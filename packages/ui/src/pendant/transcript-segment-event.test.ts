/**
 * Pendant transcript segment event helpers preserve local ASR word timing.
 */

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  dispatchPendantTranscriptSegment,
  normalizePendantAsrWords,
  PENDANT_TRANSCRIPT_SEGMENT_EVENT,
  type PendantTranscriptSegmentDetail,
} from "./transcript-segment-event";

describe("normalizePendantAsrWords", () => {
  it("trims text, clamps words to segment duration, and keeps monotonic timing", () => {
    expect(
      normalizePendantAsrWords(
        [
          { text: " hello ", startMs: -20, endMs: 120 },
          { text: "world", startMs: 90, endMs: 1_500 },
          { text: "", startMs: 200, endMs: 300 },
          { text: "again", startMs: 300, endMs: 250 },
        ],
        1_000,
      ),
    ).toEqual([
      { text: "hello", startMs: 0, endMs: 120 },
      { text: "world", startMs: 120, endMs: 1_000 },
      { text: "again", startMs: 1_000, endMs: 1_000 },
    ]);
  });

  it("dispatches the transcript segment event with the exact detail", () => {
    const detail: PendantTranscriptSegmentDetail = {
      id: "segment-1",
      status: "resolved",
      text: "hello world",
      startedAt: 1_000,
      endedAt: 2_500,
      durationMs: 1_500,
      words: [{ text: "hello", startMs: 0, endMs: 500 }],
    };
    let received: PendantTranscriptSegmentDetail | undefined;
    const listener = (event: Event) => {
      received = (event as CustomEvent<PendantTranscriptSegmentDetail>).detail;
    };

    window.addEventListener(PENDANT_TRANSCRIPT_SEGMENT_EVENT, listener);
    dispatchPendantTranscriptSegment(detail);
    window.removeEventListener(PENDANT_TRANSCRIPT_SEGMENT_EVENT, listener);

    expect(received).toBe(detail);
  });
});
