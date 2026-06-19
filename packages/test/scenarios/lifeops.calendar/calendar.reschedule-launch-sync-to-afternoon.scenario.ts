/**
 * Single-event reschedule — "move my launch sync to the afternoon".
 *
 * The agent must (a) identify the launch sync event by title, (b) move it
 * to an afternoon slot the same day, (c) not invent a different event.
 */

import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkLaunchSyncMovedToAfternoon(
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
  if (!blob.includes("launch")) {
    return `Action payload didn't reference the launch event. Payload: ${blob.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.reschedule-launch-sync-to-afternoon",
  title: "Move the morning launch sync to an afternoon slot",
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
      title: "Launch Reschedule",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-morning-launch-sync",
      apply: seedCalendarCache({
        events: [
          {
            id: "launch-sync-morning",
            title: "Launch sync",
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
      name: "move-launch-afternoon",
      room: "main",
      text: "Move my launch sync tomorrow to the afternoon — anything after 2pm is fine.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "moved-launch-event",
      predicate: checkLaunchSyncMovedToAfternoon,
    },
    judgeRubric({
      name: "calendar-launch-afternoon-rubric",
      threshold: 0.6,
      description: `User asked to move the launch sync to the afternoon (≥14:00). Correct: agent identifies the seeded "Launch sync" event and reschedules to ≥14:00 tomorrow. Incorrect: agent moves a different event, fabricates an event name, or proposes a non-afternoon slot.`,
    }),
  ],
});
