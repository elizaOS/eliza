import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.create.weekly-weekday",
  title: "Create a weekday morning recurring stretch todo",
  domain: "todos",
  tags: ["lifeops", "todos", "time-of-day-edge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Weekly Weekday Stretch",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekday-stretch preview",
      text: "Every weekday morning, remind me to stretch.",
      responseIncludesAny: ["stretch", "weekday", "morning"],
    },
    {
      kind: "message",
      name: "weekday-stretch confirm",
      text: "Yes, save that weekday morning stretch routine.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["saved", "stretch"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Morning stretch", "Weekday stretch"],
      delta: 1,
      requiredWeekdays: [1, 2, 3, 4, 5],
      requiredWindows: ["morning"],
    },
  ],
});
