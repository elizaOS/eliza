import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.prioritize",
  title: "Ask which todo is most important",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "ambiguous-parameter"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Prioritize",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Submit tax forms",
      priority: 1,
      dueIso: "{{now+4h}}",
      isUrgent: true,
    },
    {
      type: "todo",
      name: "Water the plants",
      priority: 4,
      dueIso: "{{now+8h}}",
    },
    {
      type: "todo",
      name: "Update resume",
      priority: 3,
      dueIso: "{{now+2d}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prioritize-question",
      text: "Which of my todos is most important?",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["tax forms", "tax", "most important", "priority"],
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
