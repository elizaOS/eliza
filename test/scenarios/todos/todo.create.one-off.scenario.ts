import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.create.one-off",
  title: "Create a single one-off todo",
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
      title: "LifeOps Todos Create One-Off",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-one-off todo",
      text: "Create a todo: submit report.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["submit report", "todo", "added", "saved"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Submit report",
      titleAliases: ["Submit Report", "submit report"],
      delta: 1,
    },
    {
      type: "memoryExists",
      content: {
        text: { $contains: "submit report" },
      },
    },
  ],
});
