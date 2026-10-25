/** Checks a spring-forward reschedule against the exact persisted event and unchanged unrelated records. */

import type { AgentRuntime } from "@elizaos/core";
import { judgeRubric, type ScenarioContext, scenario } from "@elizaos/testing";
import { LifeOpsRepository } from "../../../../src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../../../test/support/helpers/seed-grants.ts";
import { inspectCalendarReschedule } from "../../../support/helpers/calendar-reschedule-check.js";

const PACIFIC_TZ = "America/Los_Angeles";
const EIGHT_AM_UTC = "2026-03-08T15:00:00.000Z";
const TEN_AM_UTC = "2026-03-08T17:00:00.000Z";
const EVENT_ID = "seed_dst_spring_event_1";
const UNRELATED_ID = "seed_dst_spring_unrelated";
type CalendarRows = Awaited<
  ReturnType<LifeOpsRepository["listCalendarEvents"]>
>;
const seededRows = new WeakMap<AgentRuntime, CalendarRows>();

async function inspectPersistedReschedule(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as AgentRuntime | undefined;
  if (!runtime) return "scenario runtime unavailable";
  const before = seededRows.get(runtime);
  if (!before) return "persisted seed snapshot unavailable";
  const after = await new LifeOpsRepository(runtime).listCalendarEvents(
    String(runtime.agentId),
    "google",
  );
  return inspectCalendarReschedule(before, after, {
    eventId: EVENT_ID,
    startAt: TEN_AM_UTC,
    endAt: "2026-03-08T18:00:00.000Z",
  });
}

export default scenario({
  lane: "live-only",
  id: "calendar.dst-spring-forward",
  title:
    "Reschedule on the Pacific spring-forward date preserves exact local time",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "dst", "timezone", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: [],
  },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "DST Spring-Forward Reschedule",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-spring-forward-event",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
        });
        const repository = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        const startAt = EIGHT_AM_UTC;
        const endAt = new Date(
          Date.parse(EIGHT_AM_UTC) + 60 * 60_000,
        ).toISOString();
        await repository.upsertCalendarEvent({
          id: EVENT_ID,
          externalId: `${EVENT_ID}-external`,
          agentId,
          provider: "google",
          side: "owner",
          calendarId: "primary",
          title: "Board prep",
          description: "Quarterly board prep call",
          location: "",
          status: "confirmed",
          startAt,
          endAt,
          isAllDay: false,
          timezone: PACIFIC_TZ,
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [
            {
              email: "board@example.com",
              displayName: "Board Chair",
              responseStatus: "accepted",
              self: false,
              organizer: false,
              optional: false,
            },
          ],
          metadata: {},
          syncedAt: new Date(
            Date.parse(startAt) - 6 * 60 * 60_000,
          ).toISOString(),
          updatedAt: new Date(
            Date.parse(startAt) - 6 * 60 * 60_000,
          ).toISOString(),
        });
        const persisted = await repository.listCalendarEvents(
          agentId,
          "google",
        );
        const target = persisted.find((event) => event.id === EVENT_ID);
        if (!target) return "seeded event was not persisted";
        await repository.upsertCalendarEvent({
          ...target,
          id: UNRELATED_ID,
          externalId: `${UNRELATED_ID}-external`,
          title: "Unrelated afternoon appointment",
          startAt: "2026-03-08T22:00:00.000Z",
          endAt: "2026-03-08T23:00:00.000Z",
        });
        seededRows.set(
          runtime,
          await repository.listCalendarEvents(agentId, "google"),
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-reschedule-across-spring-forward",
      room: "main",
      text: `Move my 8am board prep on Sunday March 8 2026 (Pacific time) to 10am the same day. That's daylight-saving spring-forward day — please reason in local time, not UTC offsets.`,
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CALENDAR",
      minCount: 1,
    },
    {
      type: "custom",
      name: "rescheduled-event-lands-at-10am-pacific-local",
      predicate: inspectPersistedReschedule,
    },
    judgeRubric({
      name: "calendar-dst-spring-forward-rubric",
      threshold: 0.7,
      description:
        "The assistant reports the exact board prep moved to 10am Pacific on March 8, 2026, without claiming a different date or changing unrelated events. The separate persisted-state check is mandatory and cannot be replaced by wording in the reply.",
    }),
  ],
});
