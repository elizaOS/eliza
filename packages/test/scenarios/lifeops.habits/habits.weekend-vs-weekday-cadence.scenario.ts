/**
 * Habits: weekend-only or weekday-only cadence — running every weekday
 * (Mon-Fri). The agent must NOT include Sat/Sun.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "habits.weekend-vs-weekday-cadence",
  title: "Weekday-only running habit excludes Sat/Sun",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "weekly", "weekday-only"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Weekday Only",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekday-run preview",
      text: "Remind me to go for a run every weekday morning, never on weekends.",
      responseIncludesAny: ["run", "weekday", "monday", "friday", "morning"],
    },
    {
      kind: "message",
      name: "weekday-run confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "run"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Run",
      titleAliases: ["Weekday run", "Morning run", "Go for a run"],
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 2, 3, 4, 5],
      requireReminderPlan: true,
    },
  ],
});
