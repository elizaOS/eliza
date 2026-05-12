/**
 * Sleep: user wants a bedtime reminder 90 minutes before sleep — this
 * should create a habit/scheduled task tied to bedtime - 90min.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "sleep.bedtime-reminder-90min-before",
  title: "Bedtime wind-down reminder 90 minutes before sleep",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "habit", "reminder"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Bedtime Reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bedtime preview",
      text: "Remind me 90 minutes before bed every night so I can wind down.",
      responseIncludesAny: ["90", "bed", "wind"],
    },
    {
      kind: "message",
      name: "bedtime confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "wind", "bed"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Wind down",
      titleAliases: [
        "Bedtime wind down",
        "Wind-down reminder",
        "Pre-bed wind-down",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
