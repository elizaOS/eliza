/**
 * Attendee and care-about matching for non-Latin names and phrases. The old
 * ASCII-only normalizer turned Hangul to "", and `"alice".includes("")` routed
 * every follow-up to the first non-Latin attendee.
 */

import type { TranscriptSegment } from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import {
  analyzeMeetingGhostTranscript,
  type MeetingGhostAttendee,
} from "./index.js";

function seg(
  speakerLabel: string,
  startMs: number,
  text: string,
): TranscriptSegment {
  return {
    speakerLabel,
    startMs,
    endMs: startMs + 4000,
    text,
  } as TranscriptSegment;
}

function analyze(
  attendees: readonly MeetingGhostAttendee[],
  segments: readonly TranscriptSegment[],
  careAbouts: readonly string[] = [],
) {
  return analyzeMeetingGhostTranscript({
    transcript: {
      meetingId: "meeting-1",
      title: "Weekly sync",
      startedAt: "2026-10-05T09:00:00.000Z",
      timeZone: "UTC",
      attendees,
      segments,
    },
    owner: {
      ownerUserId: "owner-1",
      ownerDisplayName: "Owner",
      requestedBy: "meeting-ghost",
      careAbouts,
      approvalExpiresAt: new Date("2026-10-12T00:00:00.000Z"),
    },
  });
}

const minsu = { name: "김민수", email: "minsu@example.com" };
const seojun = { name: "이서준", email: "seojun@example.com" };
const alice = { name: "Alice Park", email: "alice@example.com" };

describe("meeting ghost attendee matching", () => {
  it("prefers the exact name over an earlier partial match", () => {
    const result = analyze(
      [
        { name: "김민수", email: "long@example.com" },
        { name: "김", email: "exact@example.com" },
      ],
      [seg("김", 0, "I will send the notes tomorrow.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBe("exact@example.com");
  });

  it("does not choose the first of ambiguous partial names", () => {
    const result = analyze(
      [
        { name: "김민수", email: "first@example.com" },
        { name: "김서준", email: "second@example.com" },
      ],
      [seg("김", 0, "I will send the notes tomorrow.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBeNull();
    expect(result.followUpApprovals).toHaveLength(0);
  });

  it("prefers a whole-word match over a substring of another attendee", () => {
    const result = analyze(
      [
        { name: "Ann Lee", email: "ann.lee@example.com" },
        { name: "Joanne Park", email: "joanne.park@example.com" },
      ],
      [seg("Ann Lee", 0, "Ann will send the report by Friday.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBe("ann.lee@example.com");
    expect(result.followUpApprovals[0]?.payload).toMatchObject({
      to: ["ann.lee@example.com"],
    });
  });

  it("keeps a fragment match when no whole-word match exists", () => {
    const result = analyze(
      [
        { name: "Ann Lee", email: "ann.lee@example.com" },
        { name: "Joanne Park", email: "joanne.park@example.com" },
      ],
      [seg("Joanne Park", 0, "Joann will send the report by Friday.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBe(
      "joanne.park@example.com",
    );
  });

  it("does not choose between two whole-word matches", () => {
    const result = analyze(
      [
        { name: "Ann Lee", email: "ann.lee@example.com" },
        { name: "Ann Park", email: "ann.park@example.com" },
      ],
      [seg("Ann Lee", 0, "Ann will send the report by Friday.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBeNull();
    expect(result.followUpApprovals).toHaveLength(0);
  });

  it("matches canonically equivalent names without dropping vowel marks", () => {
    const result = analyze(
      [{ name: "José", email: "jose@example.com" }],
      [seg("Jose\u0301", 0, "I will send the notes tomorrow.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBe("jose@example.com");
  });

  it("does not hand an English speaker's follow-up to a Korean attendee", () => {
    const result = analyze(
      [minsu, alice],
      [seg("Alice Park", 0, "Alice will send the deck by Friday.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBe("alice@example.com");
    expect(result.followUpApprovals[0]?.payload).toMatchObject({
      to: ["alice@example.com"],
    });
  });

  it("routes a Korean speaker's own commitment to that speaker", () => {
    const result = analyze(
      [minsu, seojun],
      [seg("이서준", 0, "I will send the notes by Friday.")],
    );
    expect(result.commitments[0]?.who).toBe("이서준");
    expect(result.commitments[0]?.recipientEmail).toBe("seojun@example.com");
  });

  it("returns null when no attendee matches", () => {
    const result = analyze(
      [minsu, alice],
      [seg("Bob", 0, "Bob will update the budget sheet by Friday.")],
    );
    expect(result.commitments[0]?.recipientEmail).toBeNull();
    expect(result.followUpApprovals).toHaveLength(0);
  });

  it("keeps English-only matching unchanged", () => {
    const result = analyze(
      [alice, { name: "Bob Lee", email: "bob@example.com" }],
      [
        seg("Alice Park", 0, "Bob will update the budget sheet by Friday."),
        seg("Alice Park", 5000, "I will send the deck tomorrow."),
      ],
    );
    expect(result.commitments.map((entry) => entry.recipientEmail)).toEqual([
      "bob@example.com",
      "alice@example.com",
    ]);
  });
});

describe("meeting ghost care-about matching", () => {
  it("matches a Korean care-about phrase, including a two-character word", () => {
    const result = analyze(
      [minsu],
      [
        seg("김민수", 0, "다음 분기 예산 삭감 얘기가 나왔습니다."),
        seg("김민수", 5000, "채용은 보류하기로 했어요."),
      ],
      ["예산 삭감", "채용"],
    );
    expect(result.careHits.map((hit) => [hit.careAbout, hit.text])).toEqual([
      ["예산 삭감", "다음 분기 예산 삭감 얘기가 나왔습니다."],
      ["채용", "채용은 보류하기로 했어요."],
    ]);
  });

  it("keeps English care-about matching unchanged", () => {
    const result = analyze(
      [alice],
      [seg("Alice Park", 0, "The hiring budget for Q4 is frozen.")],
      ["Q4 budget", "ok"],
    );
    expect(result.careHits.map((hit) => hit.careAbout)).toEqual(["Q4 budget"]);
  });
  it("does not match a short Latin care-about inside a longer word", () => {
    const result = analyze(
      [alice],
      [
        seg("Alice Park", 0, "I'll book the room."),
        seg("Alice Park", 5000, "ok, let's go."),
      ],
      ["ok"],
    );
    expect(result.careHits.map((hit) => hit.text)).toEqual(["ok, let's go."]);
  });

  it("does not match a Latin acronym care-about inside unrelated words", () => {
    const result = analyze(
      [alice],
      [
        seg("Alice Park", 0, "We booked a room."),
        seg("Alice Park", 5000, "She said the email can wait."),
        seg("Alice Park", 10000, "Three people joined."),
        seg("Alice Park", 15000, "The AI review moves to Monday."),
      ],
      ["ok", "AI", "HR"],
    );
    expect(result.careHits.map((hit) => [hit.careAbout, hit.text])).toEqual([
      ["AI", "The AI review moves to Monday."],
    ]);
  });

  it("does not match a short Arabic care-about inside a longer word", () => {
    const result = analyze(
      [alice],
      [
        seg("Alice Park", 0, "المنزل جاهز"),
        seg("Alice Park", 5000, "من فضلك راجع الميزانية"),
      ],
      ["من"],
    );
    expect(result.careHits.map((hit) => hit.text)).toEqual([
      "من فضلك راجع الميزانية",
    ]);
  });

  it("matches a Korean two-character care-about followed by a particle", () => {
    const result = analyze(
      [minsu],
      [seg("김민수", 0, "채용을 다음 주로 미루자")],
      ["채용"],
    );
    expect(result.careHits.map((hit) => hit.careAbout)).toEqual(["채용"]);
  });

  it("still matches an English multi-word phrase inside a sentence", () => {
    const result = analyze(
      [alice],
      [seg("Alice Park", 0, "We talked about the budget cut for Q4.")],
      ["budget cut"],
    );
    expect(result.careHits.map((hit) => hit.careAbout)).toEqual(["budget cut"]);
  });
});
