import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.block-websites.manual-indefinite",
  title: "Block X with no duration until manual unblock",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "manual-block", "multi-turn"],
  description:
    "If the user does not specify a duration, the website block should stay active until they explicitly remove it.",
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
      title: "SelfControl Manual Indefinite Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "start-manual-block",
      room: "main",
      text: "Block x.com so I stop doomscrolling.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/until/i, /unblock/i, /x/i],
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find(
          (action) => action.actionName === "WEBSITE_BLOCK",
        );
        if (!hit) {
          return "Expected WEBSITE_BLOCK to fire for the manual block request.";
        }
        const blob = JSON.stringify({
          parameters: hit.parameters ?? null,
          result: hit.result?.data ?? null,
        });
        if (!/"durationMinutes":null/.test(blob)) {
          return `Expected the manual block to persist with durationMinutes=null. Payload: ${blob}`;
        }
      },
    },
    {
      kind: "message",
      name: "remove-manual-block",
      room: "main",
      text: "Okay, unblock x.com now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/removed/i, /x/i, /block/i],
      assertTurn: (turn) => {
        if (/scheduled end time/i.test(turn.responseText ?? "")) {
          return `Manual unblock should not talk about a scheduled end time. Response: ${turn.responseText}`;
        }
      },
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
      profile: "e2e-selfcontrol-manual-indefinite",
    },
  ],
});
