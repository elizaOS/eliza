import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.list.upcoming",
  title: "List upcoming todos for the week",
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
      title: "LifeOps Todos List Upcoming",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Team review",
      dueIso: "{{now+2d}}",
    },
    {
      type: "todo",
      name: "Finalize slides",
      dueIso: "{{now+4d}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-upcoming",
      text: "What's coming up this week?",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "team review",
        "finalize slides",
        "slides",
        "review",
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
