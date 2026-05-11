/**
 * Create a recurring 1hr daily "time with Jill" block — cadence + relationship
 * link must both be respected. The PRD calls these out as core "Suite A:
 * Relationship cadences" features.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkRecurringAndRelationshipReferenced(
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
  // Must reference Jill and a recurrence/daily pattern.
  if (!blob.includes("jill")) {
    return `Action payload didn't reference Jill. Payload: ${blob.slice(0, 400)}`;
  }
  const recurSignals = [
    "daily",
    "every day",
    "recurring",
    "recurrence",
    "rrule",
    "freq=daily",
  ];
  if (!recurSignals.some((s) => blob.includes(s))) {
    return `Action didn't mark the event as recurring/daily. Payload: ${blob.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.recurr-relationship-block",
  title: "Daily 1hr 'time with Jill' block creates a recurring event",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "recurring", "relationships"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationship Cadence",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-empty",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-recurring-jill-time",
      room: "main",
      text: "Create a recurring 1-hour block every evening at 7pm called 'time with Jill' — daily, starting tomorrow.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "recurring-relationship-event-created",
      predicate: checkRecurringAndRelationshipReferenced,
    },
    judgeRubric({
      name: "calendar-recurr-relationship-rubric",
      threshold: 0.6,
      description: `User asked for a recurring DAILY 1-hour event called "time with Jill" starting tomorrow at 7pm. Correct: agent creates a recurring event (daily / RRULE FREQ=DAILY / etc.) titled appropriately. Incorrect: agent creates a single one-off event with no recurrence, or fails to mention Jill, or sets the duration to something other than 60 minutes.`,
    }),
  ],
});
