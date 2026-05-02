import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "reminder.water.hourly-weekdays",
  title: "Drink water hourly on weekdays",
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
      title: "Reminders Water Hourly Weekdays",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water hourly preview",
      text: "Remind me to drink water every hour on weekdays.",
      responseIncludesAny: ["water", "hour", "weekday"],
    },
    {
      kind: "message",
      name: "water hourly confirm",
      text: "Yes, save that reminder.",
      responseIncludesAny: ["saved", "water"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 60,
      requiredWeekdays: [1, 2, 3, 4, 5],
      requireReminderPlan: true,
    },
  ],
});
