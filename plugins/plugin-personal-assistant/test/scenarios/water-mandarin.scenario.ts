/**
 * Live-model scenario: Mandarin phrasing persists a "Drink water" task.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "water-mandarin",
  title: "Drink water from Mandarin Chinese phrasing (neutral)",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      title: "LifeOps Water Mandarin",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water default preview",
      text: "帮我提醒一下记得多喝水",
      responseIncludesAny: [
        "drink water",
        "water",
        "reminder",
        "喝水",
        "水",
        "提醒",
      ],
    },
    {
      kind: "message",
      name: "water default confirm",
      text: "好的，就这么定，保存吧",
      responseIncludesAny: [
        "saved",
        "drink water",
        "water",
        "已保存",
        "喝水",
        "水",
      ],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["喝水", "多喝水", "记得多喝水"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
