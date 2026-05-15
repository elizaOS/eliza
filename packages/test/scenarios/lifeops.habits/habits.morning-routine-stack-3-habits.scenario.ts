/**
 * Habits: morning routine stack of 3 habits — distinct from
 * habit.morning-routine.full-stack which sets 4 habits. This is a tighter
 * "brush + water + meditate" trio.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "habits.morning-routine-stack-3-habits",
  title: "Morning routine stack: brush, water, meditate",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "multi-action", "morning"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Morning 3-Stack",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning 3-stack preview",
      text: "Set up a quick morning routine: brush teeth, drink a big glass of water, and meditate for 5 minutes.",
      responseIncludesAny: ["brush", "water", "meditate"],
    },
    {
      kind: "message",
      name: "morning 3-stack confirm",
      text: "Yes, save all three as morning habits.",
      responseIncludesAny: ["saved", "morning"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Morning brush teeth"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Morning water", "Glass of water"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Meditate",
      titleAliases: ["Morning meditation", "5-minute meditation"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
