/**
 * Multi-habit creation for a nightly wind-down routine: brush teeth,
 * stretch, and a wind-down step. Mirror of the morning routine scenario.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "habit.night-routine.full-stack",
  title: "Set up a full night routine in one request",
  domain: "habits",
  tags: ["lifeops", "habits", "multi-action"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Night Routine",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "night-routine preview",
      text: "Build my night routine: brush my teeth, do an evening stretch, and a 15-minute wind-down before bed.",
      responseIncludesAny: ["brush", "stretch", "wind", "routine", "night"],
    },
    {
      kind: "message",
      name: "night-routine confirm",
      text: "Yes, save those as my nightly habits.",
      responseIncludesAny: ["saved", "night"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Night brush teeth", "Evening brush teeth"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Evening stretch", "Night stretch"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Wind down",
      titleAliases: [
        "Wind-down",
        "Bedtime wind down",
        "Evening wind down",
        "Pre-bed wind-down",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
