/**
 * Bulk reschedule when a travel window changes — the user just learned their
 * Tokyo trip moved by a day, and three meetings during the old travel
 * window need to be moved, declined, or kept as virtual.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

function checkAllThreeMeetingsAddressed(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const names = ["priya", "marcus", "aria"];
  const missing = names.filter((n) => !reply.includes(n));
  if (missing.length > 0) {
    return `Reply didn't address all three meetings. Missing: ${missing.join(", ")}. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.travel-blackout-reschedule",
  title: "Bulk-reschedule three meetings when the travel window slides by a day",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "travel", "bulk-reschedule"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Travel Blackout Bulk Reschedule",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-three-meetings-during-travel",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
        });
        const repo = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        const now = new Date();
        // Seed three meetings spread across the old travel day (now + 3d).
        const baseDay = new Date(now.getTime() + 3 * 24 * 60 * 60_000);
        const meetings = [
          { id: "mtg-priya", name: "1:1 with Priya", offsetHours: 10 },
          { id: "mtg-marcus", name: "Architecture review with Marcus", offsetHours: 13 },
          { id: "mtg-aria", name: "Coffee with Aria", offsetHours: 15 },
        ];
        for (const m of meetings) {
          const startMs = new Date(
            baseDay.getFullYear(),
            baseDay.getMonth(),
            baseDay.getDate(),
            m.offsetHours,
          ).getTime();
          await repo.upsertCalendarEvent({
            id: m.id,
            externalId: `${m.id}-ext`,
            agentId,
            provider: "google",
            side: "owner",
            calendarId: "primary",
            title: m.name,
            description: "",
            location: "",
            status: "confirmed",
            startAt: new Date(startMs).toISOString(),
            endAt: new Date(startMs + 30 * 60_000).toISOString(),
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
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "travel-window-shift",
      room: "main",
      text: "My Tokyo trip slid by a day — I'm now traveling on what used to be my home day. I have three meetings on that day (Priya, Marcus, Aria). Help me figure out which to reschedule, decline, or move to virtual.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "all-three-meetings-addressed",
      predicate: checkAllThreeMeetingsAddressed,
    },
    judgeRubric({
      name: "calendar-travel-blackout-rubric",
      threshold: 0.6,
      description: `Travel window shifted; three meetings (Priya, Marcus, Aria) on the new travel day each need a decision: reschedule, decline, or move to virtual. Correct: agent names ALL three and proposes a decision for each. Incorrect: agent addresses only one or two, or proposes a single decision for all without distinguishing.`,
    }),
  ],
});
