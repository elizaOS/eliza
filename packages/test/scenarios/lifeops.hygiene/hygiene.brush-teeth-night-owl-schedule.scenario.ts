/**
 * Hygiene: night-owl phrasing — "I'm usually up really late". The agent
 * should still bind both brushing slots to wake-up + bedtime windows without
 * inventing a 4am alarm.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.brush-teeth-night-owl-schedule",
  title: "Brush teeth twice daily for a night-owl phrasing",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "colloquial"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Brush Night Owl",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush night-owl preview",
      text: "I'm usually up really late, but please help me brush my teeth when I wake up and before I finally go to bed.",
      responseIncludesAny: ["brush", "wake", "bed"],
    },
    {
      kind: "message",
      name: "brush night-owl confirm",
      text: "Yes, save that brushing routine.",
      responseIncludesAny: ["saved", "brush"],
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
