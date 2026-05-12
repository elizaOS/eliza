/**
 * Shared corporate calendar without write access — the agent must surface
 * the permission gap, not pretend it succeeded.
 *
 * Failure mode guarded: when the calendar grant is read-only and the user
 * asks to add an event to a shared team calendar, the agent silently writes
 * to their own primary calendar OR reports success without flagging the
 * permission error.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

function checkAgentReportsPermissionGap(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "permission",
    "read-only",
    "read only",
    "no write",
    "can't write",
    "cannot write",
    "don't have access",
    "do not have access",
    "not authorized",
    "unauthorized",
    "owner",
    "shared",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent did not surface the permission gap on a read-only shared calendar. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.shared-calendar-permission-denied",
  title: "Read-only shared calendar surfaces the permission gap",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "permissions", "robustness"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Shared Calendar Permission",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-readonly-shared-calendar",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        // Only seed READ capability — no write.
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read"],
          email: "team@example.test",
        });
        const repo = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        // Seed an existing shared team meeting so the agent has context.
        await repo.upsertCalendarEvent({
          id: "shared-team-standup",
          externalId: "shared-team-standup-ext",
          agentId,
          provider: "google",
          side: "owner",
          calendarId: "team-shared-calendar",
          title: "Team standup",
          description: "",
          location: "",
          status: "confirmed",
          startAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
          endAt: new Date(Date.now() + 6.5 * 60 * 60_000).toISOString(),
          isAllDay: false,
          timezone: "America/Los_Angeles",
          htmlLink: null,
          conferenceLink: null,
          organizer: { email: "manager@example.test" },
          attendees: [],
          metadata: { accessRole: "reader" },
          syncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "try-write-to-shared-calendar",
      room: "main",
      text: "Add a 'Quarterly planning' event to the team shared calendar for next Thursday at 2pm.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "agent-reports-permission-gap",
      predicate: checkAgentReportsPermissionGap,
    },
    judgeRubric({
      name: "calendar-shared-permission-rubric",
      threshold: 0.6,
      description: `User asked to write to a SHARED calendar where the agent has READ ONLY access. Correct: agent reports it lacks write permission, names the calendar, and either suggests the user grant write access or proposes adding the event to a calendar they own. Incorrect: agent claims success silently, writes to a different calendar without flagging the substitution, or fabricates a confirmation.`,
    }),
  ],
});
