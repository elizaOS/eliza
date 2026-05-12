/**
 * Hygiene: water default frequency — colloquial "help me remember to drink
 * water" should resolve to a sensible interval (every 3 hours, ~4 times
 * during the day).
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.water-default-frequency",
  title: "Drink water default daily frequency",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "interval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Water Default",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water default preview",
      text: "help me remember to drink water",
      responseIncludesAny: ["drink water", "water"],
    },
    {
      kind: "message",
      name: "water default confirm",
      text: "yes, save it",
      responseIncludesAny: ["saved", "water"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
