/**
 * Live-model smoke scenario: casual Brazilian Portuguese phrasing yields a daily 8am/9pm brushing habit save.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-portuguese",
  title: "Brush teeth from casual Brazilian Portuguese phrasing",
  domain: "tasks",
  tags: ["lifeops", "tasks", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      title: "LifeOps Brush Teeth Portuguese",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth portuguese preview",
      text: "me lembra de escovar os dentes todo dia, 8 da manhã e 9 da noite",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "escovar",
        "dentes",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth portuguese confirm",
      text: "isso, pode salvar essa rotina aí",
      responseIncludesAny: [
        "saved",
        "brush",
        "teeth",
        "salv",
        "escovar",
        "dentes",
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
        "Escovar os dentes",
        "Rotina de escovação",
        "Rotina de escovar os dentes",
      ],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
  ],
});
