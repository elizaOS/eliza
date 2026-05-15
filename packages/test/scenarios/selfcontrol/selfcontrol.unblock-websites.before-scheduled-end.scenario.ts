import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.unblock-websites.before-scheduled-end",
  title: "Timed website blocks can be removed before their scheduled end",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "multi-turn", "timed-block"],
  description:
    "A timed block should be removable before it naturally expires, and the response should say that clearly.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Timed Early Unblock",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "start-timed-block",
      room: "main",
      text: "Block x.com for 30 minutes.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/30/i, /x/i, /block/i],
    },
    {
      kind: "message",
      name: "early-unblock",
      room: "main",
      text: "Unblock x.com right now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/before its scheduled end time/i, /x/i],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-timed-early-unblock",
    },
  ],
});
