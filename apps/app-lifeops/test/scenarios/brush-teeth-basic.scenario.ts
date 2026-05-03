import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-basic",
  title: "Brush teeth basic save flow",
  domain: "tasks",
  tags: ["lifeops", "tasks", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Brush Teeth Basic",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth preview",
      text: "Help me brush my teeth at 8 am and 9 pm every day.",
      responseIncludesAny: ["brush teeth", "brushing habit", "set that up"],
    },
    {
      kind: "message",
      name: "brush-teeth confirm",
      text: "Yes, save that brushing routine.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: [
        "Brush Teeth 8 + 9 Pm",
        "Brush teeth 8 + 9 pm",
        "Brush teeth 8 am & 9 pm",
      ],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
  ],
});
