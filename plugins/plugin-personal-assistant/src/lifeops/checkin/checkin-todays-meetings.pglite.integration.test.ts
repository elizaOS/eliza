/**
 * The morning check-in lists the owner's calendar under "Calendar today".
 * Google sync stores an agent-account calendar with side = 'agent' and a
 * side-specific id, so a meeting both accounts attend is stored twice. Real
 * LifeOps runtime with PGlite; the rows go through the calendar repository.
 */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { LifeOpsService } from "../service.js";
import { CheckinService } from "./checkin-service.js";

function googleEvent(args: {
  agentId: string;
  side: "owner" | "agent";
  grantId: string;
  externalId: string;
  title: string;
  startAt: string;
  endAt: string;
}): LifeOpsCalendarEvent {
  return {
    id: `${args.agentId}:google:${args.side}:grant:${args.grantId}:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: args.agentId,
    provider: "google",
    side: args.side,
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: args.startAt,
    endAt: args.endAt,
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    connectorAccountId: `account-${args.grantId}`,
    grantId: args.grantId,
  };
}

it("lists only the owner's calendar under Calendar today", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const { runtime } = fixture;
    const agentId = String(runtime.agentId);
    const service = new LifeOpsService(runtime);
    const shared = {
      agentId,
      externalId: "design-review",
      title: "Design review",
      startAt: "2026-10-06T18:00:00.000Z",
      endAt: "2026-10-06T19:00:00.000Z",
    };
    const owner = googleEvent({ ...shared, side: "owner", grantId: "g1" });
    await service.repository.upsertCalendarEvent(owner);
    // The agent account attends the same meeting and has one of its own.
    await service.repository.upsertCalendarEvent(
      googleEvent({ ...shared, side: "agent", grantId: "g2" }),
    );
    await service.repository.upsertCalendarEvent(
      googleEvent({
        agentId,
        side: "agent",
        grantId: "g2",
        externalId: "agent-sync",
        title: "Agent account sync",
        startAt: "2026-10-06T20:00:00.000Z",
        endAt: "2026-10-06T20:30:00.000Z",
      }),
    );

    const report = await new CheckinService(runtime).runMorningCheckin({
      now: new Date("2026-10-06T15:00:00.000Z"),
      timezone: "UTC",
      persist: false,
    });

    expect(report.collectorErrors.todaysMeetings).toBeNull();
    expect(report.todaysMeetings.map((meeting) => meeting.id)).toEqual([
      owner.id,
    ]);
    expect(
      report.briefingSections.find(
        (section) => section.key === "calendar_changes",
      )?.summary,
    ).toMatch(/^1 event on today's calendar/);
    expect(report.summaryText).toContain("Calendar today: 1.");
    expect(report.summaryText.match(/Design review/g)).toHaveLength(1);
    expect(report.summaryText).not.toContain("Agent account sync");
  } finally {
    await fixture.cleanup();
  }
});
