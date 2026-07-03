/**
 * Habits: weekly habit completed Sunday night vs Monday morning. The week
 * boundary should respect the user's locale (week starts Sunday US, Monday
 * EU). This scenario verifies the agent surfaces the right week's progress.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

function expectYogaWeeklyProgress(ctx: ScenarioContext): string | undefined {
  const action = ctx.actionsCalled.find(
    (entry) => entry.actionName === "CHECKIN",
  );
  const data =
    action?.result?.data && typeof action.result.data === "object"
      ? (action.result.data as {
          habitSummaries?: Array<{ title?: string; weeklyProgress?: unknown }>;
        })
      : null;
  if (!data) {
    return "expected CHECKIN to return structured habit data";
  }
  const yoga = data.habitSummaries?.find(
    (habit) => (habit.title ?? "").toLowerCase() === "yoga",
  );
  if (!yoga) {
    return `expected Yoga in CHECKIN habitSummaries, saw ${JSON.stringify(data.habitSummaries ?? null)}`;
  }

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (
    !/yoga/i.test(reply) ||
    !/(week|this week|progress|time|done)/i.test(reply)
  ) {
    return `expected weekly Yoga progress in reply, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "habits.week-spanning-behavior",
  title: "Weekly habit progress respects the user's week boundary",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "weekly", "locale"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Week Span",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-weekly-yoga",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Yoga",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekly-progress",
      text: "How many times have I done yoga this week?",
      expectedActions: ["CHECKIN"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "weekly-yoga-progress-uses-checkin-data",
      predicate: expectYogaWeeklyProgress,
    },
  ],
});
