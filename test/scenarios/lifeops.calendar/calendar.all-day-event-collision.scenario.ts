/**
 * Reschedule a meeting into a day where an all-day event already exists.
 *
 * Failure mode guarded: agent treats all-day events as "no event" because
 * their startAt is at 00:00 local and endAt is at 24:00 local, missing them
 * in a naive overlap check. The user is OOO (all-day) on the target day —
 * the agent must surface the conflict, not silently overlay the meeting.
 *
 * Cited: docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md — all-day
 * event interaction has zero scenarios.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

function checkAgentSurfacesAllDayConflict(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "all-day",
    "all day",
    "ooo",
    "out of office",
    "out-of-office",
    "vacation",
    "off",
    "blocked",
    "conflict",
    "unavailable",
  ];
  const hasSignal = signals.some((s) => reply.includes(s));
  if (!hasSignal) {
    return `Agent didn't acknowledge the all-day event blocking the target day. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.all-day-event-collision",
  title: "Rescheduling into an all-day OOO day surfaces the conflict",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "all-day", "conflict-detection"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "All-Day Event Collision",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-all-day-ooo-plus-meeting",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
        });
        const repo = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        const now = new Date();
        const targetDay = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
        const targetDayISO = targetDay.toISOString().slice(0, 10);
        // All-day OOO event on the target day.
        await repo.upsertCalendarEvent({
          id: "all-day-ooo-target",
          externalId: "all-day-ooo-target-ext",
          agentId,
          provider: "google",
          side: "owner",
          calendarId: "primary",
          title: "OOO — personal",
          description: null,
          location: null,
          status: "confirmed",
          startAt: `${targetDayISO}T00:00:00.000Z`,
          endAt: `${targetDayISO}T23:59:59.000Z`,
          isAllDay: true,
          timezone: "America/Los_Angeles",
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: {},
          syncedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        // Existing meeting today (so "move it" is unambiguous).
        const todayPlusOne = new Date(now.getTime() + 24 * 60 * 60_000)
          .toISOString();
        await repo.upsertCalendarEvent({
          id: "meeting-to-move",
          externalId: "meeting-to-move-ext",
          agentId,
          provider: "google",
          side: "owner",
          calendarId: "primary",
          title: "Marketing sync",
          description: null,
          location: null,
          status: "confirmed",
          startAt: todayPlusOne,
          endAt: new Date(Date.parse(todayPlusOne) + 30 * 60_000).toISOString(),
          isAllDay: false,
          timezone: "America/Los_Angeles",
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: {},
          syncedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "move-into-all-day-conflict",
      room: "main",
      text: "Push my marketing sync from tomorrow to the day after at 2pm.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "agent-surfaces-all-day-conflict",
      predicate: checkAgentSurfacesAllDayConflict,
    },
    judgeRubric({
      name: "calendar-all-day-collision-rubric",
      threshold: 0.6,
      description: `User asked to move a meeting onto a day that's already marked as all-day OOO. Correct: agent notices the all-day block and either asks for a different day, suggests alternatives, or explicitly flags the conflict before proceeding. Incorrect: agent silently overlays the meeting onto the OOO day. Score 0 if no acknowledgment of "OOO" / "all-day" / "out of office" appears.`,
    }),
  ],
});
