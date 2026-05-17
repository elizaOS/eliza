import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.create.recurring-daily",
  title: "Create a daily recurring todo with preview + confirm",
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
      title: "LifeOps Todos Create Daily",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "recurring-daily preview",
      text: "Create a daily todo: brush teeth.",
      responseIncludesAny: ["brush teeth", "daily", "every day", "set that up"],
    },
    {
      kind: "message",
      name: "recurring-daily confirm",
      text: "Yes, save that daily brushing todo.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["saved", "brush teeth", "daily"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Brush Teeth", "brush teeth"],
      delta: 1,
      cadenceKind: "daily",
    },
  ],
});
