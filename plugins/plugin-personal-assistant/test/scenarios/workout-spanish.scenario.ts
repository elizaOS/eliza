/**
 * Live-model scenario: casual Spanish phrasing persists a "Workout" habit
 * definition.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "workout-spanish",
  title: "Workout blocker from casual Spanish phrasing",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      title: "LifeOps Rutina de Ejercicio",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "workout spanish preview",
      text: "ármame una rutina de ejercicio todas las tardes. bloquéame X, Instagram y Hacker News hasta que la termine y después déjamelos abiertos una hora",
      responseIncludesAny: [
        "workout",
        "rutina",
        "ejercicio",
        "bloque",
        "tarde",
      ],
    },
    {
      kind: "message",
      name: "workout spanish confirm",
      text: "dale, guárdame la rutina",
      responseIncludesAny: ["saved", "workout", "guard", "rutina", "ejercicio"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Workout",
      titleAliases: ["Rutina de ejercicio", "Ejercicio", "Entrenamiento"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["afternoon"],
      requireReminderPlan: true,
      websiteAccess: {
        unlockMode: "fixed_duration",
        unlockDurationMinutes: 60,
        websites: [
          "x.com",
          "twitter.com",
          "instagram.com",
          "news.ycombinator.com",
        ],
      },
    },
  ],
});
