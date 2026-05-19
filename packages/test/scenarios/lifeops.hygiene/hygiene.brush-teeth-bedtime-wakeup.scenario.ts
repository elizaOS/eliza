/**
 * Hygiene: brush teeth at "wake-up and bedtime" phrasing — colloquial
 * input that should still resolve to the canonical morning+night slots.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.brush-teeth-bedtime-wakeup",
  title: "Brush teeth from wake-up and bedtime colloquial phrasing",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "colloquial"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Brush Wake Bed",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush wake-bed preview",
      text: "make sure i actually brush my teeth when i wake up and before bed lol",
      responseIncludesAny: ["brush", "wake", "bed"],
    },
    {
      kind: "message",
      name: "brush wake-bed confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "brush"],
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
