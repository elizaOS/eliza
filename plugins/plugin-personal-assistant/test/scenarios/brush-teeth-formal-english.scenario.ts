/**
 * Live-model smoke scenario: formal executive-register English ("I would appreciate it if you could establish…") still routes to a daily 8am/9pm brushing habit save.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-formal-english",
  title: "Brush teeth from formal executive-register English phrasing",
  domain: "tasks",
  tags: ["lifeops", "tasks", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "signal",
      title: "LifeOps Brush Teeth Formal English",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth formal english preview",
      text: "I would appreciate it if you could establish a daily reminder for me to brush my teeth at 8:00 a.m. and again at 9:00 p.m.",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "establish",
        "reminder",
        "daily routine",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth formal english confirm",
      text: "Yes, kindly proceed and save that brushing routine.",
      responseIncludesAny: [
        "saved",
        "brush teeth",
        "set that up",
        "proceed",
        "confirmed",
      ],
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
