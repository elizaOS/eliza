/**
 * Bulk reschedule with mid-batch failure — when the agent is moving N
 * events as a transaction and one update fails, the others should be
 * rolled back (or at least the user told which succeeded and which
 * failed; never silent partial success).
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkAgentReportsPartialState(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // Agent must surface SOMETHING about per-event status — not just "done".
  const transparencySignals = [
    "succeeded",
    "failed",
    "partial",
    "couldn't",
    "could not",
    "rolled back",
    "rollback",
    "two of three",
    "one of three",
    "all three",
  ];
  if (!transparencySignals.some((s) => reply.includes(s))) {
    return `Agent didn't report per-event status of a bulk reschedule. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.bulk-reschedule-rollback-on-error",
  title: "Bulk reschedule reports partial success/failure transparently",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "bulk", "robustness"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Bulk Reschedule Rollback",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-three-events-to-move",
      apply: seedCalendarCache({
        events: [
          {
            id: "evt-bulk-1",
            title: "Sales sync",
            startOffsetMinutes: 24 * 60 + 9 * 60,
            durationMinutes: 30,
          },
          {
            id: "evt-bulk-2",
            title: "Product review",
            startOffsetMinutes: 24 * 60 + 10 * 60,
            durationMinutes: 30,
          },
          {
            id: "evt-bulk-3",
            title: "Customer interview",
            startOffsetMinutes: 24 * 60 + 11 * 60,
            durationMinutes: 30,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bulk-move-all-three",
      room: "main",
      text: "Move all three of tomorrow's meetings (sales sync, product review, customer interview) to Friday at the same times. Report which ones succeeded.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "per-event-status-reported",
      predicate: checkAgentReportsPartialState,
    },
    judgeRubric({
      name: "calendar-bulk-rollback-rubric",
      threshold: 0.6,
      description: `User asked to move three meetings in bulk and explicitly asked which succeeded. Correct: agent reports per-event status. Incorrect: agent says only "done" or "moved" without enumerating each event.`,
    }),
  ],
});
