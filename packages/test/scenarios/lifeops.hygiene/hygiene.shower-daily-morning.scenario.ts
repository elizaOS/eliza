/**
 * Hygiene: shower every morning — daily cadence anchored to the morning slot.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.shower-daily-morning",
  title: "Shower every morning",
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
      title: "LifeOps Hygiene Shower Daily",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shower daily preview",
      text: "Remind me to shower every morning when I wake up.",
      responseIncludesAny: ["shower", "morning"],
    },
    {
      kind: "message",
      name: "shower daily confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "shower"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shower",
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
