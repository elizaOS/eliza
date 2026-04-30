import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.cross-device.create-and-query",
  title:
    "Create a todo on the dashboard, confirm it, then query it from mobile",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Todos Cross-Device Main",
    },
    {
      id: "mobile",
      source: "telegram",
      title: "LifeOps Todos Cross-Device Mobile",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-on-dashboard",
      room: "main",
      text: "Create a todo: pick up dry cleaning tomorrow.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["dry cleaning", "confirm", "save"],
    },
    {
      kind: "message",
      name: "confirm-on-dashboard",
      room: "main",
      text: "Yes, save it.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["saved", "dry cleaning", "tomorrow"],
    },
    {
      kind: "message",
      name: "query-on-mobile",
      room: "mobile",
      text: "What's on my todo list?",
      responseIncludesAny: ["dry cleaning"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIFE",
      status: "success",
      minCount: 3,
    },
  ],
});
