import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-night-owl",
  title: "Brush teeth for a night-owl phrasing",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Brush Teeth Night Owl",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth night-owl preview",
      text: "I'm usually up really late, but please help me brush my teeth when I wake up and before I finally go to bed.",
      responseIncludesAny: ["brush", "teeth", "wake", "bed"],
    },
    {
      kind: "message",
      name: "brush-teeth night-owl confirm",
      text: "Yes, save that brushing routine.",
      responseIncludesAny: ["saved", "brush", "teeth"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["brush teeth"],
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
