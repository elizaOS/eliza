/**
 * Cancel a tentative event — "the launch checklist isn't happening anymore".
 *
 * Personal Google Calendar is read-only. The agent must identify the event,
 * explain that cancellation is unavailable, and never claim it was removed.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { seedCalendarCache } from "../../../scenario-support/lifeops-seeds.ts";

function checkReadOnlyCancellation(ctx: ScenarioContext): string | undefined {
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
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (
    !["read-only", "view-only", "can't", "cannot", "unsupported"].some((s) =>
      reply.includes(s),
    )
  ) {
    return `Agent did not disclose the read-only Google Calendar boundary. Reply: ${reply.slice(0, 300)}`;
  }
  if (
    /\b(successfully (cancelled|canceled|deleted|removed)|(was|has been) (cancelled|canceled|deleted|removed))\b/.test(
      reply,
    )
  ) {
    return `Agent falsely claimed the event was changed. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "calendar.cancel-tentative-launch-checklist",
  title:
    "Tentative-event cancellation fails closed on read-only Google Calendar",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "cancel"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
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
      name: "read-only-cancellation-reported",
      predicate: checkReadOnlyCancellation,
    },
    judgeRubric({
      name: "calendar-cancel-read-only-rubric",
      threshold: 0.6,
      description: `User asked to cancel the seeded 'Launch checklist' event on personal Google Calendar. Correct: agent references the event, explains that this connection is read-only, and states that nothing changed. Incorrect: agent claims the event was cancelled, deleted, removed, or rescheduled.`,
    }),
  ],
});
