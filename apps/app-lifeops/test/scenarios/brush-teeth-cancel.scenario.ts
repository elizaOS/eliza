import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-cancel",
  title: "Brush teeth cancel before save",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Brush Teeth Cancel",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth preview",
      text: "Help me brush my teeth in the morning and at night.",
      responseIncludesAll: ["brush teeth"],
    },
    {
      kind: "message",
      name: "brush-teeth cancel",
      text: "Actually never mind, do not save it yet.",
      responseExcludes: ['saved "brush teeth"'],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      delta: 0,
    },
  ],
});
