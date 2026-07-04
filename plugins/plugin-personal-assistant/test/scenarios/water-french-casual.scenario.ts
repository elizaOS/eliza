/**
 * Live-model scenario: casual French (tu) phrasing persists a "Drink water"
 * task.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "water-french-casual",
  title: "Drink water from casual French (tu) phrasing",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      title: "LifeOps Water French Casual",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water french casual preview",
      text: "tu peux m'aider à penser à boire de l'eau ?",
      responseIncludesAny: [
        "drink water",
        "water",
        "reminder",
        "eau",
        "boire",
        "rappel",
      ],
    },
    {
      kind: "message",
      name: "water french casual confirm",
      text: "ouais c'est bon, enregistre ça",
      responseIncludesAny: [
        "saved",
        "drink water",
        "water",
        "enregistr",
        "eau",
      ],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: [
        "Boire de l'eau",
        "Penser à boire de l'eau",
        "Hydratation",
      ],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
