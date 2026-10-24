/**
 * The active-reminder overview must not list a reminder for a meeting the
 * owner declined: the scheduler already skips such events, so a rendered row
 * would promise a reminder that never fires.
 */

import type {
  LifeOpsCalendarEvent,
  LifeOpsReminderPlan,
} from "@elizaos/contracts";
import { expect, it } from "vitest";
import { buildActiveCalendarEventReminders } from "./service-helpers-misc.js";

const now = new Date("2026-10-20T15:00:00.000Z");

function meeting(
  id: string,
  title: string,
  responseStatus: string,
  startAt: string,
): LifeOpsCalendarEvent {
  return {
    id,
    externalId: `ext-${id}`,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title,
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt: new Date(new Date(startAt).getTime() + 50 * 60_000).toISOString(),
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [
      {
        email: "owner@example.test",
        displayName: null,
        responseStatus,
        self: true,
        organizer: true,
        optional: false,
      },
    ],
    metadata: {},
    syncedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function plan(id: string): LifeOpsReminderPlan {
  return {
    id: `plan-${id}`,
    agentId: "agent-1",
    ownerType: "calendar_event",
    ownerId: id,
    steps: [{ channel: "in_app", offsetMinutes: 30, label: "30m before" }],
    mutePolicy: {},
    quietHours: {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

it("lists no reminder for a meeting the owner declined", () => {
  const declined = meeting(
    "event-declined",
    "Team sync",
    "declined",
    "2026-10-20T15:10:00.000Z",
  );
  const accepted = meeting(
    "event-accepted",
    "Design review",
    "accepted",
    "2026-10-20T15:20:00.000Z",
  );
  const plansByEventId = new Map<string, LifeOpsReminderPlan>([
    [declined.id, plan(declined.id)],
    [accepted.id, plan(accepted.id)],
  ]);

  const reminders = buildActiveCalendarEventReminders(
    [declined, accepted],
    plansByEventId,
    "entity-owner",
    now,
  );

  expect(reminders.map((reminder) => reminder.title)).toEqual([
    "Design review",
  ]);
});
