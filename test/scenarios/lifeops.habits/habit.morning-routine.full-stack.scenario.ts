/**
 * Multi-habit creation in a single turn: full morning routine covering
 * brush teeth, stretch, water, and vitamins. Verifies the agent can
 * create multiple habit definitions from one natural-language request.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "habit.morning-routine.full-stack",
  title: "Set up a full morning routine in one request",
  domain: "habits",
  tags: ["lifeops", "habits", "multi-action", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Morning Routine",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-routine preview",
      text: "Set up my morning routine: brush my teeth, stretch, drink water, and take my vitamins.",
      responseIncludesAny: ["brush", "stretch", "water", "vitamins", "routine"],
    },
    {
      kind: "message",
      name: "morning-routine confirm",
      text: "Yes, save all of those as morning habits.",
      responseIncludesAny: ["saved", "morning"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Morning brush teeth", "Brush teeth morning"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Morning stretch", "Stretching"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Water", "Morning water"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      titleAliases: ["Vitamins", "Morning vitamins"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
