/**
 * Hygiene: haircut every 6 weeks — long-cadence interval habit. The agent
 * should compute the right interval (not collapse it to a weekly habit).
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.haircut-every-6-weeks",
  title: "Haircut every 6 weeks",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "long-interval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Haircut",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "haircut preview",
      text: "Remind me to book a haircut every 6 weeks.",
      responseIncludesAny: ["haircut", "6 weeks", "six weeks"],
    },
    {
      kind: "message",
      name: "haircut confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "haircut"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Haircut",
      titleAliases: ["Book a haircut", "Get a haircut"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
