import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.list.overdue",
  title: "List overdue todos",
  domain: "todos",
  tags: ["lifeops", "todos", "time-of-day-edge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos List Overdue",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "File expense report",
      dueIso: "{{now-2h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-overdue",
      text: "Anything overdue?",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "file expense report",
        "expense",
        "overdue",
        "past due",
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
