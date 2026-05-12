/**
 * Hygiene: water habit aligned to meal times — explicit at-meal cadence,
 * not interval. Verifies the agent picks the daily kind with breakfast,
 * lunch, dinner windows.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.water-custom-cadence-with-meals",
  title: "Drink water with every meal",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "meal-anchored"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Water With Meals",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water meals preview",
      text: "Remind me to drink a glass of water with every meal: breakfast, lunch, and dinner.",
      responseIncludesAny: ["water", "meal", "breakfast", "lunch", "dinner"],
    },
    {
      kind: "message",
      name: "water meals confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "water"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Water with meals", "Glass of water with meals"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
