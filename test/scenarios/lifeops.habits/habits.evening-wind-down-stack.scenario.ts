/**
 * Habits: evening wind-down stack — 3 distinct evening habits in one
 * request. Distinct from the existing night-routine full-stack.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "habits.evening-wind-down-stack",
  title: "Evening wind-down stack: dim lights, journal, stretch",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "multi-action", "evening"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Evening Wind Down",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "evening stack preview",
      text: "Help me set up an evening wind-down: dim the lights, journal for 5 minutes, and stretch before bed.",
      responseIncludesAny: ["lights", "journal", "stretch", "evening", "wind"],
    },
    {
      kind: "message",
      name: "evening stack confirm",
      text: "Yes, save all three as evening habits.",
      responseIncludesAny: ["saved", "evening", "night"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Dim lights",
      titleAliases: ["Dim the lights", "Evening lights"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Journal",
      titleAliases: ["Journaling", "Evening journal", "5-minute journal"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Evening stretch", "Night stretch", "Pre-bed stretch"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
