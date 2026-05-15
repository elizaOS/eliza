import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shower-weekly-basic",
  title: "Shower weekly cadence",
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
      title: "LifeOps Shower Weekly",
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
      requiredWindows: ["morning", "night"],
      requireReminderPlan: true,
    },
  ],
});
