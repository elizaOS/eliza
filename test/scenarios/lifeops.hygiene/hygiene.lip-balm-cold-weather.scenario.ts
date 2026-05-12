/**
 * Hygiene: lip balm during cold weather — interval habit during the winter
 * months. The agent should create an interval-based habit, not a one-off
 * reminder.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.lip-balm-cold-weather",
  title: "Lip balm every few hours during cold weather",
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
      title: "LifeOps Hygiene Lip Balm",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "lip balm preview",
      text: "Remind me to put on lip balm every few hours when it's cold out.",
      responseIncludesAny: ["lip balm", "hours", "cold"],
    },
    {
      kind: "message",
      name: "lip balm confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "lip balm"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Lip balm",
      titleAliases: ["Apply lip balm", "Put on lip balm"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
