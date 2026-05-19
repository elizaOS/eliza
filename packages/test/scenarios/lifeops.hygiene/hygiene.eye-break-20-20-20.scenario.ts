/**
 * Hygiene: 20-20-20 rule for eye breaks — every 20 minutes, look at
 * something 20 feet away for 20 seconds. Interval habit at 20 minutes.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.eye-break-20-20-20",
  title: "20-20-20 eye break every 20 minutes",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "interval", "eyes"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Eye Break",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "eye preview",
      text: "Set up the 20-20-20 rule for me — every 20 minutes I should look at something 20 feet away for 20 seconds.",
      responseIncludesAny: ["20", "eyes", "eye", "look"],
    },
    {
      kind: "message",
      name: "eye confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "eye"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Eye break",
      titleAliases: ["20-20-20", "20 20 20", "Eye rest", "Look away"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 20,
      requireReminderPlan: true,
    },
  ],
});
