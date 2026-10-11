/**
 * Non-Latin names and care-abouts in the meeting-ghost analyzer.
 *
 * `normalize` used to keep only [a-z0-9], so a non-Latin attendee name
 * normalized to "" and `findAttendeeEmail` matched that empty name against
 * every speaker (`"".includes(x)` / `x.includes("")`), addressing follow-up
 * approvals to the first attendee. A Korean care-about likewise normalized
 * away and never hit. Pure analyzer, no runtime.
 */
import type { TranscriptSegment } from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import {
  analyzeMeetingGhostTranscript,
  type MeetingGhostAttendee,
  type MeetingGhostOwnerContext,
} from "./index.js";

const OWNER: MeetingGhostOwnerContext = {
  ownerUserId: "owner-1",
  ownerDisplayName: "Owner",
  requestedBy: "owner-1",
  careAbouts: [],
  approvalExpiresAt: new Date("2026-10-20T00:00:00.000Z"),
};

function seg(
  speakerLabel: string,
  startMs: number,
  text: string,
): TranscriptSegment {
  return {
    id: `${speakerLabel}-${startMs}`,
    speakerLabel,
    startMs,
    endMs: startMs + 8_000,
    text,
    words: [],
  };
}

function analyze(
  attendees: readonly MeetingGhostAttendee[],
  segments: readonly TranscriptSegment[],
  careAbouts: readonly string[] = [],
) {
  return analyzeMeetingGhostTranscript({
    transcript: {
      meetingId: "m1",
      title: "Weekly sync",
      startedAt: "2026-10-09T01:00:00.000Z",
      timeZone: "Asia/Seoul",
      attendees,
      segments,
    },
    owner: { ...OWNER, careAbouts },
  });
}

const KIM: MeetingGhostAttendee = { name: "김민준", email: "kim@example.com" };
const SARAH: MeetingGhostAttendee = {
  name: "Sarah Lee",
  email: "sarah@example.com",
};

describe("meeting-ghost non-Latin matching", () => {
  it("addresses a named commitment to its speaker, not a non-Latin first attendee", () => {
    const analysis = analyze(
      [KIM, SARAH],
      [seg("Sarah Lee", 0, "Sarah Lee will send the plan by Friday")],
    );
    expect(analysis.commitments).toHaveLength(1);
    expect(analysis.commitments[0]?.recipientEmail).toBe("sarah@example.com");
    expect(analysis.followUpApprovals[0]?.payload.to).toEqual([
      "sarah@example.com",
    ]);
  });

  it("resolves a non-Latin speaker label to that attendee", () => {
    const analysis = analyze(
      [SARAH, KIM],
      [seg("김민준", 0, "I will send the budget draft by Friday")],
    );
    expect(analysis.commitments).toHaveLength(1);
    expect(analysis.commitments[0]?.who).toBe("김민준");
    expect(analysis.commitments[0]?.recipientEmail).toBe("kim@example.com");
  });

  it("hits a Korean care-about that appears in the segment", () => {
    const analysis = analyze(
      [],
      [seg("Sarah Lee", 0, "예산 승인 건은 다음 주로 미룹니다")],
      ["예산 승인"],
    );
    expect(analysis.careHits.map((hit) => hit.careAbout)).toEqual([
      "예산 승인",
    ]);
  });

  it("keeps English controls unchanged", () => {
    const analysis = analyze(
      [SARAH],
      [
        seg(
          "Sarah Lee",
          0,
          "Sarah Lee will review the budget approval by Friday",
        ),
      ],
      ["budget approval"],
    );
    expect(analysis.commitments[0]?.recipientEmail).toBe("sarah@example.com");
    expect(analysis.careHits).toHaveLength(1);
  });
});
