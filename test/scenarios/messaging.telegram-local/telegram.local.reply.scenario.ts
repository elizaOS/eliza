import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "telegram.local.reply",
  title: "Reply to Telegram chat with confirmation",
  domain: "messaging.telegram-local",
  tags: ["messaging", "telegram", "confirmation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Telegram Local Reply",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft telegram reply",
      room: "main",
      text: "Reply to the last Telegram message from Carol saying I'm on my way.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "telegram draft reply",
        includesAny: ["telegram", "Carol", "draft", "reply"],
      }),
      responseIncludesAny: ["draft", "carol", "telegram"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 1 must produce a Telegram draft reply to Carol and keep it unsent until confirmation.",
      },
    },
    {
      kind: "message",
      name: "confirm send",
      room: "main",
      text: "Send it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "telegram send after confirmation",
        includesAny: ["send", "telegram", "reply"],
      }),
      responseIncludesAny: ["sent", "sending", "send"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 2 must reflect that the drafted Telegram reply is now being sent because the user explicitly confirmed it.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "MESSAGE"],
    },
    {
      type: "custom",
      name: "telegram-local-reply-two-step-gate",
      predicate: async (ctx) => {
        const firstBlob = JSON.stringify(ctx.turns?.[0]?.actionsCalled ?? []);
        const secondActions = ctx.turns?.[1]?.actionsCalled ?? [];
        const secondBlob = JSON.stringify(secondActions);
        if (
          /send|"confirmed":true/i.test(firstBlob) &&
          !/draft/i.test(firstBlob)
        ) {
          return "first turn appears to have sent the Telegram reply instead of drafting it";
        }
        const sendAction = secondActions.find((entry) =>
          ["MESSAGE", "MESSAGE"].includes(
            entry.actionName,
          ),
        );
        if (!sendAction) {
          return "second turn did not call the Telegram send action after confirmation";
        }
        if (!/"confirmed":true|send/i.test(secondBlob)) {
          return "second turn did not carry a confirmed Telegram send payload";
        }
        if (!/telegram/i.test(secondBlob)) {
          return "second turn send payload did not identify Telegram as the channel";
        }
      },
    },
    {
      type: "custom",
      name: "telegram-local-reply-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "telegram draft then send",
        includesAny: ["telegram", "draft", "send", "reply"],
        minCount: 2,
      }),
    },
    judgeRubric({
      name: "telegram-local-reply-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted a Telegram reply first and only sent it after the explicit confirmation turn.",
    }),
  ],
});
