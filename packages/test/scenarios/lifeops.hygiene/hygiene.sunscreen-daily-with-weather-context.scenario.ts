/**
 * Hygiene: sunscreen every morning — agent should create a daily habit and
 * (when surfaced via the morning brief) acknowledge weather context. This
 * scenario focuses on creation only; weather-conditional firing is a runtime
 * concern owned by the orchestrator.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.sunscreen-daily-with-weather-context",
  title: "Sunscreen every morning with weather context",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Sunscreen",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "sunscreen preview",
      text: "Remind me to put on sunscreen every morning before I head out.",
      responseIncludesAny: ["sunscreen", "morning"],
    },
    {
      kind: "message",
      name: "sunscreen confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "sunscreen"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Sunscreen",
      titleAliases: ["Put on sunscreen", "Apply sunscreen"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
