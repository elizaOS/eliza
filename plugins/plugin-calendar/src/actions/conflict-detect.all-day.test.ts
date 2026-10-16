/**
 * CONFLICT_DETECT must block the local day of an Apple Calendar all-day event.
 *
 * EventKit sends an all-day event as local midnight of the event zone with an
 * end at 23:59:59 of the last day, so the availability engine needs an
 * exclusive end date (last day + 1). CalendarService already converts it that
 * way; this suite pins the CONFLICT_DETECT feed adapter to the same rule. The
 * only substitution is the CalendarService transport, which returns a recorded
 * feed.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createConflictDetectAction } from "./conflict-detect.js";

const AGENT_ID = "conflict-detect-all-day-agent";

function appleAllDayEvent(args: {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
}) {
  return {
    id: args.id,
    externalId: args.id,
    agentId: AGENT_ID,
    provider: "apple_calendar" as const,
    side: "owner" as const,
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: args.startAt,
    endAt: args.endAt,
    isAllDay: true,
    timezone: "Asia/Tokyo",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function feedRuntime(events: unknown[]): IAgentRuntime {
  const feed = {
    source: "synced" as const,
    syncedAt: "2026-06-01T00:00:00.000Z",
    timeMin: "2026-06-01T00:00:00.000Z",
    timeMax: "2026-06-08T00:00:00.000Z",
    events,
  };
  return {
    agentId: AGENT_ID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: vi.fn((name: string) =>
      name === "calendar" ? { getCalendarFeed: async () => feed } : undefined,
    ),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

async function conflictTitles(
  runtime: IAgentRuntime,
  proposal: { startISO: string; endISO: string },
): Promise<string[]> {
  const action = createConflictDetectAction({ authorize: async () => true });
  const message = {
    id: "00000000-0000-0000-0000-000000000301",
    entityId: "00000000-0000-0000-0000-000000000302",
    roomId: "00000000-0000-0000-0000-000000000303",
    content: { text: "does this slot work" },
  } as Memory;
  const result = await action.handler(
    runtime,
    message,
    undefined,
    {
      parameters: {
        action: "scan_event_proposal",
        timeZone: "Asia/Tokyo",
        proposal,
      },
    },
    undefined,
  );
  expect(result.success).toBe(true);
  const data = result.data as {
    conflicts?: { eventA: { title: string }; eventB: { title: string } }[];
  };
  return (data.conflicts ?? []).flatMap((conflict) => [
    conflict.eventA.title,
    conflict.eventB.title,
  ]);
}

describe("CONFLICT_DETECT Apple Calendar all-day coverage", () => {
  it("blocks a single-day Apple all-day event across its whole local day", async () => {
    // June 3 on a Tokyo device: 2026-06-03T00:00 JST .. 2026-06-03T23:59:59 JST.
    const runtime = feedRuntime([
      appleAllDayEvent({
        id: "apple-jun-3",
        title: "June 3 offsite",
        startAt: "2026-06-02T15:00:00.000Z",
        endAt: "2026-06-03T14:59:59.000Z",
      }),
    ]);

    // 12:00 to 13:00 on June 3 in Tokyo.
    const titles = await conflictTitles(runtime, {
      startISO: "2026-06-03T03:00:00.000Z",
      endISO: "2026-06-03T04:00:00.000Z",
    });

    expect(titles).toContain("June 3 offsite");
  });

  it("keeps a multi-day Apple all-day event blocking its last local day", async () => {
    // June 3 to June 5 on a Tokyo device.
    const runtime = feedRuntime([
      appleAllDayEvent({
        id: "apple-jun-3-5",
        title: "June 3-5 offsite",
        startAt: "2026-06-02T15:00:00.000Z",
        endAt: "2026-06-05T14:59:59.000Z",
      }),
    ]);

    // 12:00 to 13:00 on June 5 in Tokyo.
    const titles = await conflictTitles(runtime, {
      startISO: "2026-06-05T03:00:00.000Z",
      endISO: "2026-06-05T04:00:00.000Z",
    });

    expect(titles).toContain("June 3-5 offsite");
  });

  it("does not hold the day after a single-day Apple all-day event", async () => {
    const runtime = feedRuntime([
      appleAllDayEvent({
        id: "apple-jun-3",
        title: "June 3 offsite",
        startAt: "2026-06-02T15:00:00.000Z",
        endAt: "2026-06-03T14:59:59.000Z",
      }),
    ]);

    // 12:00 to 13:00 on June 4 in Tokyo.
    const titles = await conflictTitles(runtime, {
      startISO: "2026-06-04T03:00:00.000Z",
      endISO: "2026-06-04T04:00:00.000Z",
    });

    expect(titles).not.toContain("June 3 offsite");
  });

  it("does not hold the day before a single-day Apple all-day event", async () => {
    const runtime = feedRuntime([
      appleAllDayEvent({
        id: "apple-jun-3",
        title: "June 3 offsite",
        startAt: "2026-06-02T15:00:00.000Z",
        endAt: "2026-06-03T14:59:59.000Z",
      }),
    ]);

    // 12:00 to 13:00 on June 2 in Tokyo.
    const titles = await conflictTitles(runtime, {
      startISO: "2026-06-02T03:00:00.000Z",
      endISO: "2026-06-02T04:00:00.000Z",
    });

    expect(titles).not.toContain("June 3 offsite");
  });
});
