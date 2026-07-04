/**
 * Live-model scenario: Japanese formal phrasing persists a "Drink water" task
 * with an interval reminder plan.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "water-japanese-formal",
  title: "Drink water from Japanese formal phrasing",
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
      title: "LifeOps Water Japanese Formal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water japanese preview",
      text: "こまめに水を飲むのを忘れてしまうので、思い出させていただけますか",
      responseIncludesAny: [
        "drink water",
        "water",
        "reminder",
        "水",
        "飲む",
        "リマインダー",
      ],
    },
    {
      kind: "message",
      name: "water japanese confirm",
      text: "はい、それで保存をお願いいたします",
      responseIncludesAny: ["saved", "drink water", "water", "保存", "水"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["水を飲む", "水分補給", "こまめに水を飲む"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
