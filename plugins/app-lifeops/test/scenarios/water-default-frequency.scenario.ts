import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "water-default-frequency",
  title: "Drink water default daily frequency",
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
      title: "LifeOps Water Default",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water default preview",
      text: "help me remember to drink water",
      responseIncludesAny: ["drink water", "water", "reminder"],
    },
    {
      kind: "message",
      name: "water default confirm",
      text: "yes, save it",
      responseIncludesAny: ["saved", "drink water", "water"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
