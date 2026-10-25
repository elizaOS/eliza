/**
 * Verifies a live-model reschedule through persisted calendar state on the
 * Pacific fall-back date. Exact target identity, duration and unrelated records
 * remain authoritative; timestamps mentioned in model output are not receipts.
 */

import type { AgentRuntime } from "@elizaos/core";
import { judgeRubric, type ScenarioContext, scenario } from "@elizaos/testing";
import { LifeOpsRepository } from "../../../../src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../../../test/support/helpers/seed-grants.ts";
import { inspectCalendarReschedule } from "../../../support/helpers/calendar-reschedule-check.js";

const PACIFIC_TZ = "America/Los_Angeles";
const EIGHT_AM_UTC = "2025-11-02T16:00:00.000Z";
const NINE_AM_UTC = "2025-11-02T17:00:00.000Z";
const EVENT_ID = "seed_dst_event_1";
const UNRELATED_ID = "seed_dst_unrelated";
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
    startAt: NINE_AM_UTC,
    endAt: "2025-11-02T17:30:00.000Z",
  });
}

export default scenario({
  lane: "live-only",
  id: "calendar.reschedule.dst-fall-back",
  title: "Reschedule on the Pacific fall-back date preserves exact local time",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "dst", "timezone", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: [],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "DST Fall-Back Reschedule",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-fall-back-event",
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
          Date.parse(EIGHT_AM_UTC) + 30 * 60_000,
        ).toISOString();
        await repository.upsertCalendarEvent({
          id: EVENT_ID,
          externalId: `${EVENT_ID}-external`,
          agentId,
          provider: "google",
          side: "owner",
          calendarId: "primary",
          title: "Investor sync",
          description: "Weekly investor catch-up",
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
              email: "investor@example.com",
              displayName: "Investor",
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
        const seeded = await repository.listCalendarEvents(agentId, "google");
        const target = seeded.find((event) => event.id === EVENT_ID);
        if (!target) return "seeded target was not persisted";
        await repository.upsertCalendarEvent({
          ...target,
          id: UNRELATED_ID,
          externalId: `${UNRELATED_ID}-external`,
          title: "Unrelated afternoon appointment",
          startAt: "2025-11-02T22:00:00.000Z",
          endAt: "2025-11-02T22:30:00.000Z",
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
      name: "request-reschedule",
      room: "main",
      // Anchor the prompt on the calendar date so the agent doesn't have to
      // guess "tomorrow". The DST cliff is independent of the prompt clock.
      text: `Move my 8am investor sync on Sunday November 2 2025 (Pacific time) to 9am the same day. That's daylight-saving fall-back day, so be careful with the timezone.`,
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
      name: "rescheduled-event-lands-at-9am-pacific-local",
      predicate: inspectPersistedReschedule,
    },
    judgeRubric({
      name: "calendar-dst-fall-back-rubric",
      threshold: 0.7,
      description:
        "The assistant reports the exact investor sync moved to 9am Pacific on November 2, 2025, without claiming a different date or changing unrelated events. The separate persisted-state check is mandatory and cannot be replaced by wording in the reply.",
    }),
  ],
});
