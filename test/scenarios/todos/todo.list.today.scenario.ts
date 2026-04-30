import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.list.today",
  title: "List todos for today",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos List Today",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Reply to Jane",
      dueIso: "{{now+3h}}",
    },
    {
      type: "todo",
      name: "Workout",
      dueIso: "{{now+5h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-today",
      text: "What's on my list today?",
      expectedActions: ["LIFE"],
      plannerIncludesAny: ["overview", "life", "<name>life</name>"],
      responseIncludesAny: ["reply to jane", "jane", "workout"],
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
