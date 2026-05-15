/**
 * Single-event reschedule — "move my roadmap sync to the afternoon".
 *
 * The agent must (a) identify the roadmap sync event by title, (b) move it
 * to an afternoon slot the same day, (c) not invent a different event.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkRoadmapSyncMovedToAfternoon(
  ctx: ScenarioContext,
): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({
      parameters: c.parameters ?? null,
      data: c.result?.data ?? null,
      text: c.result?.text ?? null,
    })),
  ).toLowerCase();
  if (!blob.includes("roadmap")) {
    return `Action payload didn't reference the roadmap event. Payload: ${blob.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.reschedule-roadmap-sync-to-afternoon",
  title: "Move the morning roadmap sync to an afternoon slot",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "reschedule"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Roadmap Reschedule",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-morning-roadmap",
      apply: seedCalendarCache({
        events: [
          {
            id: "roadmap-sync-morning",
            title: "Roadmap sync",
            startOffsetMinutes: 24 * 60 + 9 * 60 + 30,
            durationMinutes: 60,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "move-roadmap-afternoon",
      room: "main",
      text: "Move my roadmap sync tomorrow to the afternoon — anything after 2pm is fine.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "moved-roadmap-event",
      predicate: checkRoadmapSyncMovedToAfternoon,
    },
    judgeRubric({
      name: "calendar-roadmap-afternoon-rubric",
      threshold: 0.6,
      description: `User asked to move the roadmap sync to the afternoon (≥14:00). Correct: agent identifies the seeded "Roadmap sync" event and reschedules to ≥14:00 tomorrow. Incorrect: agent moves a different event, fabricates an event name, or proposes a non-afternoon slot.`,
    }),
  ],
});
