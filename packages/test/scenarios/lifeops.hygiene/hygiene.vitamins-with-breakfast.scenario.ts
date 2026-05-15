/**
 * Hygiene: vitamins with breakfast — daily morning window habit.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.vitamins-with-breakfast",
  title: "Take vitamins with breakfast every day",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Vitamins Breakfast",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vitamins preview",
      text: "Please remind me to take my vitamins with breakfast every day.",
      responseIncludesAny: ["vitamins", "breakfast", "morning"],
    },
    {
      kind: "message",
      name: "vitamins confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "vitamin"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      titleAliases: ["Vitamins", "Morning vitamins"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
