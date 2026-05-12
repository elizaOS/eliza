/**
 * DST fall-back reschedule.
 *
 * Background: in America/Los_Angeles, the 2025 fall-back transition is at
 * 02:00 local on 2025-11-02. Before fall-back, 8am Pacific is 15:00Z
 * (PDT, UTC-7). After fall-back, 8am Pacific is 16:00Z (PST, UTC-8).
 *
 * Bug class this guards: rescheduling "8am to 9am" by adding 60 minutes to
 * the UTC timestamp can land at 9am Pacific *only by accident* on non-DST
 * days. On the fall-back day, naive UTC math leaves the new event at the
 * wrong local hour. The agent must reason in local time.
 *
 * The scenario seeds a calendar event at 2025-11-02T15:00Z (8am Pacific
 * pre-DST, which is what google calendar would actually send for an event
 * created the day before) and asks the agent to move it to 9am. The
 * resulting CALENDAR action must update the event such that the new
 * start, when interpreted in America/Los_Angeles, equals 09:00 — i.e.
 * 17:00Z (9am PST after the transition).
 *
 * Note on logical clock: the scenario-runner doesn't expose a primitive to
 * pin scenario `now` to a specific instant (only `advanceClock` offsets are
 * supported). We work around that by seeding the event with absolute
 * timestamps and instructing the agent in the prompt that "tomorrow" maps
 * to 2025-11-02. The CALENDAR action's parameters / result_data carry the
 * new event start, which we inspect directly. This avoids fabrication
 * because the agent has to actually write the new time into the action.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";
import {
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const PACIFIC_TZ = "America/Los_Angeles";
// 2025-11-02 is the US DST fall-back day for Pacific Time.
const PRE_FALL_BACK_8AM_UTC = "2025-11-02T15:00:00.000Z"; // 08:00 PDT
const _PRE_FALL_BACK_9AM_UTC = "2025-11-02T16:00:00.000Z"; // 09:00 PDT (wrong target)
const _POST_FALL_BACK_9AM_UTC = "2025-11-02T17:00:00.000Z"; // 09:00 PST (correct target)
const EVENT_ID = "seed_dst_event_1";

function localHourPacific(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "";
  const hour = Number.parseInt(hourStr, 10);
  return Number.isFinite(hour) ? hour : null;
}

function inspectCalendarActionForLocalNineAm(
  ctx: ScenarioContext,
): string | undefined {
  const calls = ctx.actionsCalled.filter(
    (action) => action.actionName === "CALENDAR",
  );
  if (calls.length === 0) {
    return "expected the agent to invoke the CALENDAR action to reschedule";
  }
  // The action serializes its parameters/result_data; we look for the new
  // event start time anywhere in the captured payload and verify it lands at
  // 09:00 Pacific local. Either an ISO string or a structured field is fine.
  let foundLocalHour: number | null = null;
  let sawAnyTimestamp = false;
  for (const call of calls) {
    const blob = JSON.stringify({
      parameters: call.parameters ?? null,
      data: call.result?.data ?? null,
      values: call.result?.values ?? null,
      text: call.result?.text ?? null,
    });
    // Match every ISO-8601 timestamp in the blob.
    const isoMatches =
      blob.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z/g) ?? [];
    for (const iso of isoMatches) {
      sawAnyTimestamp = true;
      const hour = localHourPacific(iso);
      if (hour === 9) {
        foundLocalHour = 9;
        break;
      }
    }
    if (foundLocalHour === 9) break;
  }
  if (!sawAnyTimestamp) {
    return `CALENDAR action was called but no ISO timestamp appeared in parameters or result; cannot verify DST handling. Calls: ${JSON.stringify(calls.map((c) => c.actionName))}`;
  }
  if (foundLocalHour !== 9) {
    return `Expected the rescheduled CALENDAR event to land at 09:00 ${PACIFIC_TZ} (post fall-back UTC=17:00Z). No ISO timestamp in the CALENDAR action payload mapped to 09:00 Pacific local time. This usually means the agent added 1h to the UTC timestamp instead of reasoning in local time, leaving the event at 08:00 Pacific (UTC=16:00Z).`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.reschedule.dst-fall-back",
  title:
    "Reschedule across DST fall-back keeps the new event at the right LOCAL hour",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "dst", "timezone", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
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
      name: "seed-pre-fall-back-event",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
        });
        const repository = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        const startAt = PRE_FALL_BACK_8AM_UTC;
        const endAt = new Date(
          Date.parse(PRE_FALL_BACK_8AM_UTC) + 30 * 60_000,
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
      predicate: inspectCalendarActionForLocalNineAm,
    },
    {
      type: "custom",
      name: "calendar-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "DST-aware reschedule",
      }),
    },
    judgeRubric({
      name: "calendar-dst-fall-back-rubric",
      threshold: 0.7,
      description: `End-to-end: the assistant rescheduled the 8am Pacific event to 9am Pacific on November 2, 2025 (DST fall-back day). The new event start, when interpreted in America/Los_Angeles, must equal 09:00 — i.e. UTC 17:00Z (PST), NOT 16:00Z (which would be 8am PST, the same hour they were trying to escape via the user's request, masquerading as 9am because the agent added 1h of UTC). The reply may be terse — what matters is that any timestamp in the agent's reply or trace lands at 09:00 Pacific local. Score 0 if the agent mentions an 8am or 16:00Z time as the new event slot.`,
    }),
  ],
});
