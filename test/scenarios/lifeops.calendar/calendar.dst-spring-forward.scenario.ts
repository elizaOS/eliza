/**
 * DST spring-forward reschedule (mirror of the fall-back scenario).
 *
 * In America/Los_Angeles the 2026 spring-forward transition is at 02:00 local
 * on 2026-03-08. Before spring-forward, 8am Pacific is 16:00Z (PST, UTC-8).
 * After spring-forward, 8am Pacific is 15:00Z (PDT, UTC-7). The agent must
 * reason in local time, not UTC.
 *
 * Cited: docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md — DST
 * coverage has a fall-back guard but no spring-forward counterpart.
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
// 2026-03-08 is the US DST spring-forward day for Pacific Time.
const PRE_SPRING_FWD_8AM_UTC = "2026-03-08T16:00:00.000Z"; // 08:00 PST
const _POST_SPRING_FWD_9AM_UTC = "2026-03-08T16:00:00.000Z"; // 09:00 PDT
// After the transition, 9am PDT = 16:00Z. The trap is the same UTC value
// represents different local hours depending on the date — the agent must
// reason in local time.
const _POST_SPRING_FWD_10AM_UTC = "2026-03-08T17:00:00.000Z"; // 10:00 PDT (target)
const EVENT_ID = "seed_dst_spring_event_1";

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

function inspectCalendarActionForLocalTenAm(
  ctx: ScenarioContext,
): string | undefined {
  const calls = ctx.actionsCalled.filter(
    (action) => action.actionName === "CALENDAR",
  );
  if (calls.length === 0) {
    return "expected the agent to invoke the CALENDAR action to reschedule";
  }
  let foundLocalHour: number | null = null;
  let sawAnyTimestamp = false;
  for (const call of calls) {
    const blob = JSON.stringify({
      parameters: call.parameters ?? null,
      data: call.result?.data ?? null,
      values: call.result?.values ?? null,
      text: call.result?.text ?? null,
    });
    const isoMatches =
      blob.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z/g) ?? [];
    for (const iso of isoMatches) {
      sawAnyTimestamp = true;
      const hour = localHourPacific(iso);
      if (hour === 10) {
        foundLocalHour = 10;
        break;
      }
    }
    if (foundLocalHour === 10) break;
  }
  if (!sawAnyTimestamp) {
    return `CALENDAR action was called but no ISO timestamp appeared in parameters or result; cannot verify DST handling.`;
  }
  if (foundLocalHour !== 10) {
    return `Expected the rescheduled event to land at 10:00 ${PACIFIC_TZ} (post spring-forward UTC=17:00Z). No timestamp matched. The agent likely added 2h of UTC instead of reasoning in local time.`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.dst-spring-forward",
  title:
    "Reschedule across DST spring-forward keeps the event at the right LOCAL hour",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "dst", "timezone", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
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
      name: "seed-pre-spring-forward-event",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
        });
        const repository = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        const startAt = PRE_SPRING_FWD_8AM_UTC;
        const endAt = new Date(
          Date.parse(PRE_SPRING_FWD_8AM_UTC) + 60 * 60_000,
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
      predicate: inspectCalendarActionForLocalTenAm,
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
      name: "calendar-dst-spring-forward-rubric",
      threshold: 0.7,
      description: `The user moved an 8am Pacific event to 10am Pacific on the 2026-03-08 spring-forward day. Correct: the new start, interpreted in America/Los_Angeles, equals 10:00 (17:00Z PDT). Incorrect: agent added 2h to UTC and landed at 9am PDT, or fabricated a different time. Score 0 if any time in the reply is "9am PDT" or "18:00Z".`,
    }),
  ],
});
