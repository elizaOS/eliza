import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-spanish",
  title: "Brush teeth from Spanish phrasing",
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
      title: "LifeOps Brush Teeth Spanish",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth spanish preview",
      text: "recuérdame cepillarme los dientes por la mañana y por la noche",
      responseIncludesAny: ["brush", "teeth", "cepill", "mañana", "noche"],
    },
    {
      kind: "message",
      name: "brush-teeth spanish confirm",
      text: "sí, guárdalo",
      responseIncludesAny: ["saved", "brush", "teeth", "guard"],
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
