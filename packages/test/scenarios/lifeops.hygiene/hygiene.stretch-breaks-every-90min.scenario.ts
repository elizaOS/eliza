/**
 * Hygiene: stretch break every 90 minutes during work — interval cadence
 * with explicit minute count, not the generic "during the day" default.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.stretch-breaks-every-90min",
  title: "Stretch break every 90 minutes during work",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "interval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Stretch 90min",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "stretch preview",
      text: "Remind me to stand up and stretch every 90 minutes during the workday.",
      responseIncludesAny: ["stretch", "90", "minutes"],
    },
    {
      kind: "message",
      name: "stretch confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "stretch"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Stretch break", "Stretch breaks"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 90,
      requireReminderPlan: true,
    },
  ],
});
