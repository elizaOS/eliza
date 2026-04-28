/**
 * Daily habit with numeric targets: push-ups and sit-ups every morning.
 * Exercises the LIFE definition pipeline for a count-based daily habit.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "habit.sit-ups-push-ups.daily-counts",
  title: "Daily push-ups and sit-ups habit",
  domain: "habits",
  tags: ["lifeops", "habits", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Push-Ups Sit-Ups",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "habit preview",
      text: "Set up a habit to do 50 push-ups and 100 sit-ups every morning.",
      responseIncludesAny: [
        "push-ups",
        "push ups",
        "sit-ups",
        "sit ups",
        "morning",
      ],
    },
    {
      kind: "message",
      name: "habit confirm",
      text: "Yes, save that habit.",
      responseIncludesAny: ["saved", "push"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Push-ups and sit-ups",
      titleAliases: [
        "Push-ups & sit-ups",
        "Morning push-ups and sit-ups",
        "Push ups and sit ups",
        "Daily push-ups and sit-ups",
      ],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
