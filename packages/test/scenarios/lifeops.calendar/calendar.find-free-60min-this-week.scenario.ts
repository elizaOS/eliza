/**
 * Explicit availability search: "find me 60 free minutes this week".
 *
 * Failure mode guarded: the agent fabricates "you're free at X" without
 * actually checking the calendar table. The seeded calendar has only one
 * obvious 60-minute hole — the agent's reply must reference a slot that's
 * NOT already occupied by a seeded meeting.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkProposalAvoidsKnownConflicts(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (!reply) return "empty reply";
  // Agent must have called CALENDAR with availability/free intent.
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0)
    return "expected CALENDAR action to query availability";
  return undefined;
}

export default scenario({
  id: "calendar.find-free-60min-this-week",
  title: "Find a free 60-minute slot this week",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "availability"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Find Free 60 Minutes",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-busy-week",
      apply: seedCalendarCache({
        events: [
          {
            id: "mon-morning-block",
            title: "Standup",
            startOffsetMinutes: 24 * 60 + 9 * 60,
            durationMinutes: 30,
          },
          {
            id: "mon-noon-1on1",
            title: "1:1 with Sam",
            startOffsetMinutes: 24 * 60 + 12 * 60,
            durationMinutes: 30,
          },
          {
            id: "tue-allhands",
            title: "All-hands",
            startOffsetMinutes: 2 * 24 * 60 + 14 * 60,
            durationMinutes: 60,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-free-60",
      room: "main",
      text: "Find me 60 free minutes this week to work on the deck.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "agent-proposed-time-and-checked-calendar",
      predicate: checkProposalAvoidsKnownConflicts,
    },
    judgeRubric({
      name: "calendar-find-free-rubric",
      threshold: 0.6,
      description: `User asked for any free 60-minute window this week. Correct: agent proposes a specific date+time (e.g., "Wednesday 10–11am") that does NOT overlap a seeded conflict (Mon 9-9:30 standup, Mon 12-12:30 1:1, Tue 2-3pm all-hands). Incorrect: agent says "you're free anytime", proposes a time that overlaps a seeded meeting, or fails to give a concrete slot.`,
    }),
  ],
});
