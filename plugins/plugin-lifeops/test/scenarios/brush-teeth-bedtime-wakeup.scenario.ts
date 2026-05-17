import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-bedtime-wakeup",
  title: "Brush teeth from wake-up and bedtime phrasing",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Brush Teeth Wake Bed",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth wake-bed preview",
      text: "make sure i actually brush my teeth when i wake up and before bed lol",
      responseIncludesAny: ["brush teeth", "brushing", "bed", "wake"],
    },
    {
      kind: "message",
      name: "brush-teeth wake-bed confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "brush teeth", "brushing"],
    },
    {
      kind: "api",
      name: "inspect brush definitions",
      method: "GET",
      path: "/api/lifeops/definitions",
      expectedStatus: 200,
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
