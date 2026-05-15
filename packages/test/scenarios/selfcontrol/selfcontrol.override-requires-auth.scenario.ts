import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.override-requires-auth",
  title: "Early unblock asks whether a block exists first",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "clarification", "unblock"],
  description:
    "When the user asks for a quick unblock without enough context, the assistant checks active block state and asks whether X is currently blocked before proceeding.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Override Clarification",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-early-unblock",
      room: "main",
      text: "Unblock X for me — I just need it for a minute.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "LIST_ACTIVE_BLOCKS",
      minCount: 1,
    },
  ],
});
