/**
 * Unit coverage for the shared transcript story fixture (pure data, no DOM):
 * pins its deterministic literals and proves it satisfies the transcript
 * player contracts — ordered non-overlapping segments, well-formed ASR word
 * timings, and duration/speaker fields that agree with the segments.
 */
import {
  activeWordIndex,
  flattenTranscriptWords,
  transcriptDurationMs,
  transcriptSpeakerCount,
  validateAsrWordTimings,
} from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_STORY_FIXTURE } from "./transcript-story-fixtures";

describe("TRANSCRIPT_STORY_FIXTURE", () => {
  it("pins the deterministic story literals", () => {
    expect(TRANSCRIPT_STORY_FIXTURE.id).toBe("transcript-story");
    expect(TRANSCRIPT_STORY_FIXTURE.title).toBe("Planning call");
    expect(TRANSCRIPT_STORY_FIXTURE.createdAt).toBe(
      Date.UTC(2026, 7, 2, 18, 0, 0),
    );
    expect(TRANSCRIPT_STORY_FIXTURE.durationMs).toBe(4_000);
    expect(TRANSCRIPT_STORY_FIXTURE.source).toBe("voice-session");
    expect(TRANSCRIPT_STORY_FIXTURE.scope).toBe("owner-private");
    expect(TRANSCRIPT_STORY_FIXTURE.status).toBe("ready");
    expect(TRANSCRIPT_STORY_FIXTURE.speakerCount).toBe(2);
    expect(
      TRANSCRIPT_STORY_FIXTURE.segments.map((s) => [
        s.id,
        s.speakerLabel,
        s.startMs,
        s.endMs,
      ]),
    ).toEqual([
      ["segment-1", "Maya", 0, 2_000],
      ["segment-2", "Jordan", 2_200, 4_000],
    ]);
  });

  it("orders segments without overlap inside [0, durationMs]", () => {
    const { segments, durationMs } = TRANSCRIPT_STORY_FIXTURE;
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].startMs).toBe(0);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      expect(segment.startMs).toBeGreaterThanOrEqual(0);
      expect(segment.endMs).toBeLessThanOrEqual(durationMs);
      expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
      if (i > 0) {
        expect(segment.startMs).toBeGreaterThanOrEqual(segments[i - 1].endMs);
      }
    }
  });

  it("keeps every segment's text as the join of its timed words", () => {
    for (const segment of TRANSCRIPT_STORY_FIXTURE.segments) {
      expect(segment.words.length).toBeGreaterThan(0);
      const joined = segment.words.map((w) => w.text).join(" ");
      expect(joined).toBe(segment.text);
    }
  });

  it("passes the ASR word-timing contract per segment and overall", () => {
    const flat = flattenTranscriptWords(TRANSCRIPT_STORY_FIXTURE.segments);
    for (const segment of TRANSCRIPT_STORY_FIXTURE.segments) {
      const result = validateAsrWordTimings(
        segment.words,
        TRANSCRIPT_STORY_FIXTURE.durationMs,
      );
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    }
    const overall = validateAsrWordTimings(
      flat,
      TRANSCRIPT_STORY_FIXTURE.durationMs,
    );
    expect(overall.ok).toBe(true);
    expect(overall.violations).toEqual([]);
  });

  it("declares duration and speaker count consistent with the segments", () => {
    const { segments } = TRANSCRIPT_STORY_FIXTURE;
    expect(transcriptSpeakerCount(segments)).toBe(
      TRANSCRIPT_STORY_FIXTURE.speakerCount,
    );
    expect(transcriptDurationMs(segments)).toBe(
      TRANSCRIPT_STORY_FIXTURE.durationMs,
    );
  });

  it("flattens words in playback order for the player highlight", () => {
    const flat = flattenTranscriptWords(TRANSCRIPT_STORY_FIXTURE.segments);
    expect(flat.map((w) => w.startMs)).toEqual([
      0, 400, 750, 950, 1_350, 1_550, 2_200, 2_550, 2_950, 3_200,
    ]);
    // before the first word nothing is lit…
    expect(activeWordIndex(flat, -1)).toBe(-1);
    // …the first word lights exactly at t=0…
    expect(activeWordIndex(flat, 0)).toBe(0);
    // …the inter-segment gap keeps the previous word lit instead of flickering off…
    expect(activeWordIndex(flat, 2_100)).toBe(5);
    // …and the final word stays lit through the end of the recording.
    expect(activeWordIndex(flat, TRANSCRIPT_STORY_FIXTURE.durationMs)).toBe(
      flat.length - 1,
    );
  });
});
