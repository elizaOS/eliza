/**
 * Cancel a tentative event — "the launch checklist isn't happening anymore".
 *
 * Failure mode guarded: the agent confuses "cancel" with "decline" or
 * "delete locally", or marks the event as past/done instead of removing it.
 * The agent must call CALENDAR with a delete/cancel intent.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkCancelIntent(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({
      parameters: c.parameters ?? null,
      data: c.result?.data ?? null,
      text: c.result?.text ?? null,
    })),
  ).toLowerCase();
  if (!blob.includes("launch checklist")) {
    return `Action payload didn't reference 'launch checklist'. Payload: ${blob.slice(0, 400)}`;
  }
  const cancelSignals = [
    "cancel",
    "delete",
    "remove",
    "decline",
    "drop",
  ];
  if (!cancelSignals.some((s) => blob.includes(s))) {
    return `Action payload didn't indicate cancel/delete intent.`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.cancel-tentative-launch-checklist",
  title: "Cancel a tentative 'launch checklist' event cleanly",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "cancel"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cancel Tentative Event",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-tentative-event",
      apply: seedCalendarCache({
        events: [
          {
            id: "launch-checklist-tentative",
            title: "Launch checklist",
            startOffsetMinutes: 2 * 24 * 60 + 14 * 60,
            durationMinutes: 60,
            metadata: { status: "tentative" },
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cancel-launch-checklist",
      room: "main",
      text: "Cancel the launch checklist meeting — it's not happening anymore.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "cancel-intent-present",
      predicate: checkCancelIntent,
    },
    judgeRubric({
      name: "calendar-cancel-tentative-rubric",
      threshold: 0.6,
      description: `User asked to cancel 'launch checklist'. Correct: agent confirms cancellation and references the event by name. Incorrect: agent reschedules instead of cancels, fabricates a different event name, or fails to act.`,
    }),
  ],
});
