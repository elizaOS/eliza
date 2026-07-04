/**
 * Unit coverage for the live-meeting transcript reducer + metadata readers
 * (pure functions, no DOM): folding streamed events and polled snapshots into
 * the live transcript state.
 */
import type { MeetingTranscriptEvent } from "@elizaos/shared";
import type {
  Transcript,
  TranscriptSegment,
} from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import {
  applyMeetingTranscriptEvent,
  applyPolledTranscript,
  EMPTY_LIVE_TRANSCRIPT,
  meetingTranscriptMeta,
} from "./meeting-live";

function seg(id: string, text: string, startMs = 0): TranscriptSegment {
  return { id, text, startMs, endMs: startMs + 1000, words: [] };
}

function event(
  confirmed: TranscriptSegment[],
  pending: TranscriptSegment[],
): MeetingTranscriptEvent {
  return {
    type: "meeting-transcript",
    sessionId: "m1",
    transcriptId: "t1",
    confirmed,
    pending,
  };
}

describe("applyMeetingTranscriptEvent", () => {
  it("appends confirmed segments and replaces the pending tail", () => {
    const s1 = applyMeetingTranscriptEvent(
      EMPTY_LIVE_TRANSCRIPT,
      event([seg("a", "hello")], [seg("p1", "wor")]),
    );
    expect(s1.confirmed.map((s) => s.id)).toEqual(["a"]);
    expect(s1.pending.map((s) => s.id)).toEqual(["p1"]);

    const s2 = applyMeetingTranscriptEvent(
      s1,
      event([seg("b", "world", 1000)], [seg("p2", "how ar", 2000)]),
    );
    expect(s2.confirmed.map((s) => s.id)).toEqual(["a", "b"]);
    // pending is replaced wholesale, never appended
    expect(s2.pending.map((s) => s.id)).toEqual(["p2"]);
  });

  it("dedupes replayed confirmed segments by id", () => {
    const s1 = applyMeetingTranscriptEvent(
      EMPTY_LIVE_TRANSCRIPT,
      event([seg("a", "hello")], []),
    );
    const s2 = applyMeetingTranscriptEvent(
      s1,
      event([seg("a", "hello"), seg("b", "again")], []),
    );
    expect(s2.confirmed.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("clears pending when the event carries an empty tail", () => {
    const s1 = applyMeetingTranscriptEvent(
      EMPTY_LIVE_TRANSCRIPT,
      event([], [seg("p1", "wor")]),
    );
    const s2 = applyMeetingTranscriptEvent(s1, event([seg("a", "world")], []));
    expect(s2.pending).toEqual([]);
    expect(s2.confirmed.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("applyPolledTranscript", () => {
  const record = (segments: TranscriptSegment[]): Transcript => ({
    id: "t1",
    title: "Meeting",
    createdAt: 0,
    durationMs: 0,
    segments,
    source: "meeting",
    scope: "owner-private",
    status: "recording",
    speakerCount: 0,
  });

  it("adopts the server record when it has more segments", () => {
    const s1 = applyMeetingTranscriptEvent(
      EMPTY_LIVE_TRANSCRIPT,
      event([seg("a", "hello")], [seg("b", "wor")]),
    );
    const s2 = applyPolledTranscript(
      s1,
      record([seg("a", "hello"), seg("b", "world")]),
    );
    expect(s2.confirmed.map((s) => s.id)).toEqual(["a", "b"]);
    // the previously-pending segment got confirmed server-side → dropped
    expect(s2.pending).toEqual([]);
  });

  it("keeps local state when the poll has nothing new", () => {
    const s1 = applyMeetingTranscriptEvent(
      EMPTY_LIVE_TRANSCRIPT,
      event([seg("a", "hello")], [seg("p1", "wor")]),
    );
    expect(applyPolledTranscript(s1, record([seg("a", "hello")]))).toBe(s1);
  });
});

describe("meetingTranscriptMeta", () => {
  it("reads platform + participants off metadata", () => {
    const meta = meetingTranscriptMeta({
      source: "meeting",
      metadata: {
        platform: "google_meet",
        participants: [
          { id: "1", displayName: "Alice" },
          { id: "2", displayName: "Bob" },
        ],
      },
    });
    expect(meta.platform).toBe("google_meet");
    expect(meta.participants.map((p) => p.displayName)).toEqual([
      "Alice",
      "Bob",
    ]);
  });

  it("degrades malformed metadata to no badge + empty roster", () => {
    expect(meetingTranscriptMeta({ source: "meeting" })).toEqual({
      platform: null,
      participants: [],
    });
    expect(
      meetingTranscriptMeta({
        source: "meeting",
        metadata: { platform: "skype", participants: [{ id: "x" }, "junk"] },
      }),
    ).toEqual({ platform: null, participants: [] });
  });
});
