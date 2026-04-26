import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shave-weekly-formal",
  title: "Formal weekly shave phrasing",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Shave Weekly",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shave preview",
      text: "Please remind me to shave twice a week.",
      responseIncludesAny: ["shave", "twice a week", "weekly"],
    },
    {
      kind: "message",
      name: "shave confirm",
      text: "Yes, save that habit.",
      responseIncludesAny: ["saved", "shave"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shave",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 4],
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
