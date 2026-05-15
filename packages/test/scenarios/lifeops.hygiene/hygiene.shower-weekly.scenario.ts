/**
 * Hygiene: shower three times a week — weekly cadence with specific weekdays.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.shower-weekly",
  title: "Shower three times a week",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "weekly"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Shower Weekly",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shower weekly preview",
      text: "Please remind me to shower three times a week.",
      responseIncludesAny: ["shower", "week"],
    },
    {
      kind: "message",
      name: "shower weekly confirm",
      text: "Yes, save that routine.",
      responseIncludesAny: ["saved", "shower"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shower",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 3, 5],
      requireReminderPlan: true,
    },
  ],
});
