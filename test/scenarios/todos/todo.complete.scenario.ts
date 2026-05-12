import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.complete",
  title: "Mark a seeded todo as done",
  domain: "todos",
  tags: ["lifeops", "todos", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Complete",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Take out trash",
      dueIso: "{{now+1h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "complete-todo",
      text: "Mark take out trash as done.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["done", "completed", "finished", "trash"],
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
