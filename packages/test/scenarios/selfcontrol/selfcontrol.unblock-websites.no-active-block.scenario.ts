import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.unblock-websites.no-active-block",
  title: "Unblock request is a clean no-op when nothing is blocked",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "noop"],
  description:
    "If no website block is active, the unblock action should still route cleanly and explain that nothing is currently blocked.",
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
      title: "SelfControl No Active Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "noop-unblock",
      room: "main",
      text: "Unblock x.com right now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/no website block is active right now/i],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-no-active-block",
    },
  ],
});
