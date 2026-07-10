/**
 * Meeting-ghost event bridge tests.
 *
 * These keep the runtime event mapper root-Vitest friendly while the
 * `.integration.test.ts` sibling proves the consumer writes real approval and
 * ledger rows under PGlite.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { MeetingTranscriptFinalizedPayload } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { runMeetingGhostForTranscript } from "../src/lifeops/meeting-ghost/consumer.js";
import {
  handleMeetingTranscriptFinalized,
  meetingGhostInputFromFinalizedPayload,
} from "../src/lifeops/meeting-ghost/event-handler.js";

vi.mock("../src/lifeops/meeting-ghost/consumer.js", () => ({
  runMeetingGhostForTranscript: vi.fn(async () => ({
    analysis: {
      meetingId: "meeting-event-session",
      decisions: [],
      commitments: [],
      commitmentLedgerRecords: [],
      careHits: [],
      followUpApprovals: [],
      calendarIntents: [],
      digestLines: [],
    },
    enqueued: [],
    commitmentLedgerIds: [],
  })),
}));

const startedAt = Date.parse("2026-07-06T16:00:00.000Z");

function runtime(): IAgentRuntime {
  return { agentId: "agent-1" } as IAgentRuntime;
}

function payload(
  overrides: Partial<MeetingTranscriptFinalizedPayload> = {},
): MeetingTranscriptFinalizedPayload {
  return {
    session: {
      id: "meeting-event-session",
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      nativeMeetingId: "abc-defg-hij",
      botName: "Eliza Notetaker",
      status: "ended",
      requestedAt: startedAt - 60_000,
      activeAt: startedAt,
      endedAt: startedAt + 120_000,
      transcriptId: "meeting-event-transcript",
      participants: [{ id: "ava", displayName: "Ava" }],
    },
    transcript: {
      id: "meeting-event-transcript",
      title: "Ops Sync Event",
      createdAt: startedAt,
      durationMs: 120_000,
      source: "meeting",
      scope: "owner-private",
      status: "ready",
      speakerCount: 1,
      segments: [
        {
          id: "s1",
          speakerLabel: "Ava",
          startMs: 60_000,
          endMs: 68_000,
          text: "Ava will send the launch-date rollback plan by 2026-07-10.",
          words: [],
        },
      ],
    },
    ghostAttendance: {
      ownerUserId: "owner-mtg-event",
      ownerDisplayName: "Shaw",
      requestedBy: "meeting-ghost-event",
      careAbouts: ["launch date"],
      calendarId: "primary",
      approvalTtlMs: 24 * 60 * 60 * 1000,
      attendees: [{ name: "Ava", email: "ava@example.com" }],
    },
    ...overrides,
  };
}

describe("meeting ghost finalized transcript event bridge", () => {
  it("maps finalized meeting payloads to the consumer input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T17:00:00.000Z"));
    const input = meetingGhostInputFromFinalizedPayload(runtime(), payload());

    expect(input).toMatchObject({
      agentId: "agent-1",
      owner: {
        ownerUserId: "owner-mtg-event",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost-event",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt: new Date("2026-07-07T17:00:00.000Z"),
      },
      transcript: {
        meetingId: "meeting-event-session",
        title: "Ops Sync Event",
        startedAt: "2026-07-06T16:00:00.000Z",
        attendees: [{ name: "Ava", email: "ava@example.com" }],
      },
    });
    expect(input?.transcript.segments).toHaveLength(1);
    vi.useRealTimers();
  });

  it("falls back to roster names when ghost context has no attendee emails", () => {
    const input = meetingGhostInputFromFinalizedPayload(
      runtime(),
      payload({
        ghostAttendance: {
          ownerUserId: "owner-mtg-event",
          ownerDisplayName: "Shaw",
          careAbouts: [],
        },
      }),
    );

    expect(input?.owner.requestedBy).toBe("owner-mtg-event");
    expect(input?.transcript.attendees).toEqual([{ name: "Ava" }]);
  });

  it("does nothing when a finalized transcript has no ghost-attendance context", async () => {
    const run = vi.mocked(runMeetingGhostForTranscript);
    run.mockClear();

    await handleMeetingTranscriptFinalized({
      runtime: runtime(),
      source: "test",
      ...payload({ ghostAttendance: undefined }),
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("passes mapped input to the consumer", async () => {
    const run = vi.mocked(runMeetingGhostForTranscript);
    run.mockClear();

    await handleMeetingTranscriptFinalized({
      runtime: runtime(),
      source: "test",
      ...payload(),
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
      expect.objectContaining({
        agentId: "agent-1",
        transcript: expect.objectContaining({
          meetingId: "meeting-event-session",
        }),
      }),
    );
  });
});
