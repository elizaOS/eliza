import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.deprioritize",
  title: "Move a seeded todo to low priority",
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
      title: "LifeOps Todos Deprioritize",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Reorganize closet",
      priority: 2,
      dueIso: "{{now+3d}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "deprioritize",
      text: "Move reorganize closet to low priority.",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "low priority",
        "reorganize closet",
        "closet",
        "priority",
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
