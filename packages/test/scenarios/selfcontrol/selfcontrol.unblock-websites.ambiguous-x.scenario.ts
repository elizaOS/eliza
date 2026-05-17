import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.unblock-websites.ambiguous-x",
  title: "Unblock requests do not require restating the hostname",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "multi-turn", "unblock", "clarity"],
  description:
    "When the user clearly wants the current website block removed, 'can you unblock x?' should route to the website unblock action instead of asking what x means.",
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
      title: "SelfControl Ambiguous X Unblock",
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
      name: "ambiguous-unblock-still-routes",
      room: "main",
      text: "Can you unblock x?",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [
        /removed the website block/i,
        /before its scheduled end time/i,
        /no website block is active right now/i,
      ],
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
      profile: "e2e-selfcontrol-ambiguous-x-unblock",
    },
  ],
});
