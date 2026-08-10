/**
 * Bulk reschedule request against personal Google Calendar. The official MCP
 * resource is read-only, so the agent must identify the events but refuse the
 * mutation without claiming partial or complete success.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { seedCalendarCache } from "../../../scenario-support/lifeops-seeds.ts";

function checkAgentReportsReadOnlyState(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const unavailableSignals = [
    "read-only",
    "view-only",
    "can't",
    "cannot",
    "unsupported",
  ];
  if (!unavailableSignals.some((signal) => reply.includes(signal))) {
    return `Agent did not disclose that personal Google Calendar mutations are unavailable. Reply: ${reply.slice(0, 300)}`;
  }
  if (
    /\b(successfully (moved|rescheduled|updated)|(were|have been) (moved|rescheduled|updated)|succeeded)\b/.test(
      reply,
    )
  ) {
    return `Agent falsely claimed a Google Calendar mutation succeeded. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "calendar.bulk-reschedule-rollback-on-error",
  title: "Bulk reschedule fails closed on read-only personal Google Calendar",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "bulk", "robustness"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
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
      text: "Move all three of tomorrow's meetings (sales sync, product review, customer interview) to Friday at the same times.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "read-only-state-reported",
      predicate: checkAgentReportsReadOnlyState,
    },
    judgeRubric({
      name: "calendar-bulk-read-only-rubric",
      threshold: 0.6,
      description: `User asked to move three personal Google Calendar events. Correct: agent identifies the request, explains that the connected personal Google Calendar is read-only, and states that nothing changed. Incorrect: agent claims any event was moved, updated, or partially succeeded.`,
    }),
  ],
});
