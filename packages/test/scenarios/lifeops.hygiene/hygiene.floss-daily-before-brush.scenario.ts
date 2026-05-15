/**
 * Hygiene: floss daily before brushing — the agent should create a single
 * daily evening habit and not collapse it into the brushing habit.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.floss-daily-before-brush",
  title: "Floss daily before brushing teeth at night",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Floss Daily",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "floss preview",
      text: "Remind me to floss every night before I brush my teeth.",
      responseIncludesAny: ["floss", "night"],
    },
    {
      kind: "message",
      name: "floss confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "floss"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Floss",
      titleAliases: ["Floss teeth", "Floss every night", "Floss nightly"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["night", "evening"],
      requireReminderPlan: true,
    },
  ],
});
