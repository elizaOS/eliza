import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.update.priority",
  title: "Raise a seeded todo to high priority",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "multi-turn-memory"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Update Priority",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Finish tax forms",
      priority: 3,
      dueIso: "{{now+4h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "update-priority",
      text: "Make the tax forms todo high priority.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["high priority", "priority", "tax forms"],
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
