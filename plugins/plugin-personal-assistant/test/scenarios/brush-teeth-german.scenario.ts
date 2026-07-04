/**
 * Live-model smoke scenario: German formal (Sie) phrasing yields a daily 8am/9pm brushing habit save.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-german",
  title: "Brush teeth from German formal (Sie) phrasing",
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
      title: "LifeOps Brush Teeth German",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth german preview",
      text: "Könnten Sie mich bitte jeden Tag um 8 Uhr morgens und um 21 Uhr ans Zähneputzen erinnern?",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "Zähneputzen",
        "Zähne putzen",
        "erinnern",
        "einrichten",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth german confirm",
      text: "Ja, speichern Sie diese Putzroutine bitte ab.",
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
        "Zähneputzen",
        "Zaehneputzen",
        "Putzroutine",
      ],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
  ],
});
