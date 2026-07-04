/**
 * Live-model scenario: Russian (Cyrillic) phrasing persists a "Drink water"
 * task.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "water-russian",
  title: "Drink water from Russian phrasing (Cyrillic, neutral)",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Water Russian",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water default preview",
      text: "Помоги мне не забывать пить воду в течение дня.",
      responseIncludesAny: [
        "drink water",
        "water",
        "reminder",
        "вода",
        "воду",
        "пить",
        "напомина",
      ],
    },
    {
      kind: "message",
      name: "water default confirm",
      text: "да, сохрани это",
      responseIncludesAny: ["saved", "drink water", "water", "сохран", "вода"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Пить воду", "Пей воду", "Напоминание пить воду"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
