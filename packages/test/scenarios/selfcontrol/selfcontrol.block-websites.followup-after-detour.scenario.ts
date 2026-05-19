import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.block-websites.followup-after-detour",
  title: "Block previously named websites after an unrelated detour",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "multi-turn", "context-carryover"],
  description:
    "The blocker should recover the websites from recent conversation even after the user talks about something else before confirming.",
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
      title: "SelfControl Followup After Detour",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "name-sites-without-blocking",
      room: "main",
      text: "The websites distracting me are x.com and instagram.com. Do not block them yet.",
      responseIncludesAny: [/wait/i, /confirm/i, /noted/i],
    },
    {
      kind: "message",
      name: "talk-about-something-else",
      room: "main",
      text: "Also, what should I eat for lunch today?",
      responseIncludesAny: [/lunch/i, /\?/],
    },
    {
      kind: "message",
      name: "confirm-block-after-detour",
      room: "main",
      text: "Actually do it now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/x/i, /instagram/i, /block/i],
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find(
          (action) => action.actionName === "WEBSITE_BLOCK",
        );
        if (!hit) {
          return "Expected WEBSITE_BLOCK to fire after the follow-up confirmation.";
        }
        const blob = JSON.stringify({
          parameters: hit.parameters ?? null,
          result: hit.result?.data ?? null,
        });
        if (!/x\.com/.test(blob) || !/instagram\.com/.test(blob)) {
          return `Expected the follow-up block to recover x.com and instagram.com from recent conversation. Payload: ${blob}`;
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
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-followup-detour",
    },
  ],
});
