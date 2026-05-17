/**
 * Explicit free/busy query — "am I free Thursday morning?"
 *
 * Seeds two Thursday morning events. The agent must consult the calendar
 * and answer with the actual answer, not "yes" by default.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkAgentReadCalendar(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR availability query";
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // Reply should reference at least one of the seeded events.
  const seededLabels = ["product review", "investor sync"];
  if (!seededLabels.some((s) => reply.includes(s))) {
    return `Reply didn't reference the seeded Thursday morning events. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

function thursdayMorningOffsetMinutes(hour: number): number {
  const now = new Date();
  const dow = now.getUTCDay();
  const daysUntilThursday = (4 - dow + 7) % 7 || 7;
  return daysUntilThursday * 24 * 60 + hour * 60;
}

export default scenario({
  id: "calendar.check-availability-thursday-morning",
  title: "Free/busy query for Thursday morning surfaces the seeded events",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "free-busy", "availability"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Thursday Free/Busy",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-thursday-meetings",
      apply: seedCalendarCache({
        events: [
          {
            id: "thurs-9-product",
            title: "Product review",
            startOffsetMinutes: thursdayMorningOffsetMinutes(9),
            durationMinutes: 60,
          },
          {
            id: "thurs-10-30-investor",
            title: "Investor sync",
            startOffsetMinutes: thursdayMorningOffsetMinutes(10) + 30,
            durationMinutes: 30,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-thursday-free",
      room: "main",
      text: "Am I free Thursday morning?",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "agent-checked-and-reported",
      predicate: checkAgentReadCalendar,
    },
    judgeRubric({
      name: "calendar-availability-thursday-rubric",
      threshold: 0.6,
      description: `Thursday morning has TWO events: 9-10am product review and 10:30-11am investor sync. Correct: agent says the user is NOT fully free, lists at least one of the events, and may suggest a gap or alternative. Incorrect: agent says "yes, you're free" or fabricates events not seeded.`,
    }),
  ],
});
