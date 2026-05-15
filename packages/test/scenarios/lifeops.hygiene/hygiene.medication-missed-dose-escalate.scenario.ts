/**
 * Hygiene: missed medication dose escalates immediately — health-critical
 * habits should escalate after a single miss, not 2+.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { seedCheckinDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "hygiene.medication-missed-dose-escalate",
  title: "Missed medication dose surfaces immediately on check-in",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "medication", "escalation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Medication Missed",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-medication-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-medication",
        title: "Take medication",
        kind: "habit",
        dueAt: "{{now-3h}}",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-checkin",
      text: "Run my morning check-in.",
      expectedActions: ["CHECKIN"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CHECKIN",
      minCount: 1,
    },
    {
      type: "custom",
      name: "medication-overdue-surfaced",
      predicate: (ctx: ScenarioContext) => {
        const action = ctx.actionsCalled.find(
          (a) => a.actionName === "CHECKIN",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                habitSummaries?: Array<{
                  title?: string;
                  missedOccurrenceStreak?: number;
                }>;
                overdueTodos?: Array<{ title?: string }>;
              })
            : null;
        if (!data) return "expected structured check-in data";
        const med = data.habitSummaries?.find(
          (h) => h.title === "Take medication",
        );
        const overdueMed = data.overdueTodos?.find(
          (t) => t.title === "Take medication",
        );
        if (!med && !overdueMed) {
          return "expected Take medication in habitSummaries or overdueTodos";
        }
        if (med && (med.missedOccurrenceStreak ?? 0) < 1 && !overdueMed) {
          return `expected missed dose to surface either as missed streak >=1 or in overdueTodos`;
        }
        return undefined;
      },
    },
  ],
});
