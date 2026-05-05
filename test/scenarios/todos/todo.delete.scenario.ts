import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.delete",
  title: "Delete a seeded todo with confirmation",
  domain: "todos",
  tags: ["lifeops", "todos", "confirms-destructive-action"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Delete",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Reorganize garage",
      dueIso: "{{now+6h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "delete-request",
      text: "Delete the reorganize garage todo.",
      forbiddenActions: ["LIFE"],
      responseIncludesAny: ["sure", "confirm", "delete", "remove"],
    },
    {
      kind: "message",
      name: "delete-confirm",
      text: "Yes, delete it.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["deleted", "removed", "gone", "garage"],
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
