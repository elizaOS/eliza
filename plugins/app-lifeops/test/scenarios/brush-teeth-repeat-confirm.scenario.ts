import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-repeat-confirm",
  title: "Brush teeth ignores repeated save confirmation",
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
      title: "LifeOps Brush Teeth Repeat Confirm",
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
      responseIncludesAny: ["saved", "save that for you"],
    },
    {
      kind: "message",
      name: "brush-teeth repeated confirm",
      text: "Yes, that's the schedule. Save it.",
      responseIncludesAny: ["saved", "habit is saved", "will remind you"],
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
