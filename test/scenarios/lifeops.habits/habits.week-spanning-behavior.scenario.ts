/**
 * Habits: weekly habit completed Sunday night vs Monday morning. The week
 * boundary should respect the user's locale (week starts Sunday US, Monday
 * EU). This scenario verifies the agent surfaces the right week's progress.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
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
      type: "actionCalled",
      actionName: "CHECKIN",
      minCount: 1,
    },
  ],
});
