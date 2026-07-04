/**
 * Live-model smoke scenario: polite French (vous) phrasing yields a daily brushing habit, replying in-language while creating the scheduled reminder.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-french",
  title: "Brush teeth from polite French phrasing (vous)",
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
      title: "LifeOps Brush Teeth French",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth french preview",
      text: "Pourriez-vous me rappeler de me brosser les dents à 8 h et à 21 h tous les jours ?",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "brosser",
        "dents",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth french confirm",
      text: "Oui, enregistrez cette routine de brossage, s'il vous plaît.",
      responseIncludesAny: ["saved", "brush", "teeth", "enregistr", "brossage"],
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
        "Brossage des dents",
        "Se brosser les dents",
        "Routine de brossage",
      ],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
  ],
});
