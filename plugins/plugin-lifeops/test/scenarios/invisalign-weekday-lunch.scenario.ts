import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "invisalign-weekday-lunch",
  title: "Invisalign weekday lunch phrasing",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Invisalign Weekdays",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "invisalign preview",
      text: "Please remind me about my Invisalign on weekdays after lunch.",
      responseIncludesAny: ["invisalign", "weekdays", "lunch", "afternoon"],
    },
    {
      kind: "message",
      name: "invisalign confirm",
      text: "Yes, save that routine.",
      responseIncludesAny: ["saved", "invisalign"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Keep Invisalign in",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 2, 3, 4, 5],
      requiredWindows: ["afternoon"],
      requireReminderPlan: true,
    },
  ],
});
