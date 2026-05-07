import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.self-set-enforcement.enforces-yes",
  title: "Agent enforces a block once the user confirms",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "confirmation", "happy-path"],
  description:
    "Turn 1 — agent proposes a block and must not act. Turn 2 — user confirms; OWNER_WEBSITE_BLOCK must fire.",
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
      title: "SelfControl Enforces Yes",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-block",
      room: "main",
      text: "Should I block X for an hour while I do deep work?",
      forbiddenActions: ["OWNER_WEBSITE_BLOCK"],
      responseIncludesAny: [/block/i, /x/i, /hour/i, /confirm/i, /\?/],
    },
    {
      kind: "message",
      name: "confirm-block",
      room: "main",
      text: "Yes, block it for one hour.",
      expectedActions: ["OWNER_WEBSITE_BLOCK"],
      responseIncludesAny: [/blocked/i, /block/i, /hour/i, /x/i],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "OWNER_WEBSITE_BLOCK",
      minCount: 1,
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-enforces-yes",
    },
  ],
});
