import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.update.due",
  title: "Push a seeded todo's due date to tomorrow",
  domain: "todos",
  tags: ["lifeops", "todos", "multi-turn-memory"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Update Due",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Renew passport",
      dueIso: "{{now+2h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "update-due",
      text: "Push the renew passport todo to tomorrow.",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "tomorrow",
        "renew passport",
        "passport",
        "rescheduled",
      ],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIFE",
      status: "success",
      minCount: 1,
    },
  ],
});
