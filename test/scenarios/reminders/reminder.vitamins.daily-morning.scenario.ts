import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "reminder.vitamins.daily-morning",
  title: "Daily vitamins reminder in the morning window",
  domain: "reminders",
  tags: ["lifeops", "reminders", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "Reminders Vitamins Morning",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vitamins morning preview",
      text: "Please remind me to take my vitamins every morning.",
      responseIncludesAny: ["vitamin", "morning"],
    },
    {
      kind: "message",
      name: "vitamins morning confirm",
      text: "Yes, save that reminder.",
      responseIncludesAny: ["saved", "vitamin"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
