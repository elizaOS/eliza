/**
 * Tests for the post-meeting transcript producer.
 *
 * The harness uses a seeded transcript rather than a live meeting bridge so the
 * LifeOps shape is deterministic: care-about hits, decisions, commitments,
 * approval-queued follow-ups, and calendar deadline intents all have exact
 * assertions before the live joiner path is wired in.
 */

import { describe, expect, it } from "vitest";
import { analyzeMeetingGhostTranscript } from "../src/lifeops/meeting-ghost/index.js";

const approvalExpiresAt = new Date("2026-07-06T20:00:00.000Z");

function analyzeSeededTranscript() {
  return analyzeMeetingGhostTranscript({
    owner: {
      ownerUserId: "owner-1",
      ownerDisplayName: "Shaw",
      requestedBy: "meeting-ghost",
      careAbouts: ["launch date moves"],
      calendarId: "primary",
      approvalExpiresAt,
    },
    transcript: {
      meetingId: "ops-sync-2026-07-06",
      title: "Ops Sync",
      startedAt: "2026-07-06T16:00:00.000Z",
      attendees: [
        { name: "Mira", email: "mira@example.com" },
        { name: "Ava", email: "ava@example.com" },
        { name: "Ben", email: "ben@example.com" },
        { name: "Priya", email: "priya@example.com" },
      ],
      segments: [
        {
          speaker: "Mira",
          offsetMs: 30_000,
          text: "Budget is unchanged and the support rotation is fine.",
        },
        {
          speaker: "Ava",
          offsetMs: 120_000,
          text: "Decision: launch date moves from July 18 to July 22 because QA found a payments blocker.",
        },
        {
          speaker: "Ben",
          offsetMs: 180_000,
          text: "Decision: keep the pricing announcement embargoed until partner sign-off.",
        },
        {
          speaker: "Ava",
          offsetMs: 240_000,
          text: "Action: Ava will send the launch-date rollback plan by Friday.",
        },
        {
          speaker: "Ben",
          offsetMs: 300_000,
          text: "Action: Ben to update the public calendar by 2026-07-10.",
        },
        {
          speaker: "Priya",
          offsetMs: 360_000,
          text: "I will confirm partner sign-off by tomorrow.",
        },
      ],
    },
  });
}

describe("meeting ghost transcript analysis", () => {
  it("fires care-about hits for launch-date movement while ignoring unrelated transcript", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.careHits).toHaveLength(1);
    expect(analysis.careHits[0]).toMatchObject({
      careAbout: "launch date moves",
      speaker: "Ava",
      text: "Decision: launch date moves from July 18 to July 22 because QA found a payments blocker.",
    });
    expect(analysis.careHits.map((hit) => hit.text).join("\n")).not.toContain(
      "support rotation",
    );
  });

  it("keeps the digest to three lines and retains the seeded decisions first", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.digestLines).toHaveLength(3);
    expect(analysis.digestLines[0]).toBe(
      "Decision: launch date moves from July 18 to July 22 because QA found a payments blocker.",
    );
    expect(analysis.digestLines[1]).toBe(
      "Decision: keep the pricing announcement embargoed until partner sign-off.",
    );
    expect(analysis.digestLines[2]).toContain(
      "Care-about hit (launch date moves)",
    );
  });

  it("extracts exact who/what/when commitments from explicit transcript language", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.commitments).toEqual([
      expect.objectContaining({
        who: "Ava",
        recipientEmail: "ava@example.com",
        what: "send the launch-date rollback plan",
        dueText: "Friday",
        dueDate: "2026-07-10",
      }),
      expect.objectContaining({
        who: "Ben",
        recipientEmail: "ben@example.com",
        what: "update the public calendar",
        dueText: "2026-07-10",
        dueDate: "2026-07-10",
      }),
      expect.objectContaining({
        who: "Priya",
        recipientEmail: "priya@example.com",
        what: "confirm partner sign-off",
        dueText: "tomorrow",
        dueDate: "2026-07-07",
      }),
    ]);
  });

  it("queues follow-up drafts under owner approval with recipients and deadlines", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.followUpApprovals).toHaveLength(3);
    expect(analysis.followUpApprovals[0]).toMatchObject({
      requestedBy: "meeting-ghost",
      subjectUserId: "owner-1",
      action: "send_email",
      channel: "email",
      expiresAt: approvalExpiresAt,
      payload: {
        action: "send_email",
        to: ["ava@example.com"],
        subject: "Follow-up from Ops Sync",
        body: expect.stringContaining(
          "please send the launch-date rollback plan by Friday",
        ),
      },
    });
  });

  it("creates approval-gated calendar deadline intents for dated commitments", () => {
    const analysis = analyzeSeededTranscript();

    expect(analysis.calendarIntents).toHaveLength(3);
    expect(analysis.calendarIntents.map((intent) => intent.approval)).toEqual([
      expect.objectContaining({
        action: "schedule_event",
        channel: "google_calendar",
        payload: expect.objectContaining({
          action: "schedule_event",
          calendarId: "primary",
          title: "Deadline: send the launch-date rollback plan",
          attendees: ["ava@example.com"],
          startsAtMs: Date.parse("2026-07-10T09:00:00.000Z"),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Deadline: update the public calendar",
          attendees: ["ben@example.com"],
          startsAtMs: Date.parse("2026-07-10T09:00:00.000Z"),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Deadline: confirm partner sign-off",
          attendees: ["priya@example.com"],
          startsAtMs: Date.parse("2026-07-07T09:00:00.000Z"),
        }),
      }),
    ]);
  });
});
