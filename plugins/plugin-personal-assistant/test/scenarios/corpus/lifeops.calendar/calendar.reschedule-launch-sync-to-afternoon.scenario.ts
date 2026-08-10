/**
 * Single-event reschedule — "move my launch sync to the afternoon".
 *
 * The agent must identify the launch sync, explain that personal Google
 * Calendar is read-only, and avoid claiming the event moved.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { seedCalendarCache } from "../../../scenario-support/lifeops-seeds.ts";

function checkLaunchSyncWasNotMutated(
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
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (
    !["read-only", "view-only", "can't", "cannot", "unsupported"].some((s) =>
      reply.includes(s),
    )
  ) {
    return `Agent did not disclose the read-only Google Calendar boundary. Reply: ${reply.slice(0, 300)}`;
  }
  if (
    /\b(successfully (moved|rescheduled|updated)|(was|has been) (moved|rescheduled|updated))\b/.test(
      reply,
    )
  ) {
    return `Agent falsely claimed the launch sync changed. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "calendar.reschedule-launch-sync-to-afternoon",
  title: "Launch reschedule fails closed on read-only Google Calendar",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "reschedule"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
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
      name: "launch-event-not-mutated",
      predicate: checkLaunchSyncWasNotMutated,
    },
    judgeRubric({
      name: "calendar-launch-read-only-rubric",
      threshold: 0.6,
      description: `User asked to move the seeded "Launch sync" event on personal Google Calendar. Correct: agent identifies it, explains that the connection is read-only, and says nothing changed. Incorrect: agent claims it moved, rescheduled, or updated the event.`,
    }),
  ],
});
