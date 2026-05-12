import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.cross-device.global-alarm",
  title: "Setting an alarm is confirmation-gated before saving",
  domain: "todos",
  tags: ["lifeops", "todos"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Todos Cross-Device Global Alarm",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-global-alarm",
      text: "Set an alarm for 7am tomorrow to wake up.",
      responseIncludesAny: ["alarm", "7", "wake up", "correct"],
    },
    {
      kind: "message",
      name: "confirm-global-alarm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "alarm", "wake up", "7:00"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIFE",
      status: "success",
      minCount: 2,
    },
  ],
});
