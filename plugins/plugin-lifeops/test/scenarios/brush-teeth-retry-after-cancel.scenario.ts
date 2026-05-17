import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-retry-after-cancel",
  title: "Brush teeth retry after backing out",
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
      title: "LifeOps Brush Teeth Retry",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth preview",
      text: "Help me brush my teeth in the morning and at night.",
      responseIncludesAll: ["brush teeth"],
    },
    {
      kind: "message",
      name: "brush-teeth cancel",
      text: "Actually never mind, do not save it yet.",
    },
    {
      kind: "message",
      name: "brush-teeth retry preview",
      text: "Okay actually yes, help me set up brushing my teeth in the morning and at night.",
      responseIncludesAll: ["brush teeth"],
    },
    {
      kind: "message",
      name: "brush-teeth retry confirm",
      text: "Yes, save that brushing routine now.",
      responseIncludesAll: ["saved", "brush teeth"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [
        { label: "Morning", minuteOfDay: 480 },
        { label: "Night", minuteOfDay: 1260 },
      ],
      requireReminderPlan: true,
    },
  ],
});
