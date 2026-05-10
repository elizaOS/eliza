import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "signal.reply",
  title: "Reply to Signal message with confirmation",
  domain: "messaging.signal",
  tags: ["messaging", "signal", "confirmation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Signal Reply",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft signal reply",
      room: "main",
      text: "Reply on Signal to Dana saying I confirmed the booking.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "signal draft reply",
        includesAny: ["signal", "Dana", "draft", "reply"],
      }),
      responseIncludesAny: ["signal", "dana", "draft"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 1 must produce a Signal draft reply to Dana and keep it unsent until confirmation.",
      },
    },
    {
      kind: "message",
      name: "confirm send",
      room: "main",
      text: "Send it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "signal send after confirmation",
        includesAny: ["send", "signal", "reply"],
      }),
      responseIncludesAny: ["sent", "sending", "send"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 2 must reflect that the drafted Signal reply is now being sent because the user explicitly confirmed it.",
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
      name: "signal-reply-two-step-gate",
      predicate: async (ctx) => {
        const firstBlob = JSON.stringify(ctx.turns?.[0]?.actionsCalled ?? []);
        const secondBlob = JSON.stringify(ctx.turns?.[1]?.actionsCalled ?? []);
        if (
          /send|"confirmed":true/i.test(firstBlob) &&
          !/draft/i.test(firstBlob)
        ) {
          return "first turn appears to have sent the Signal reply instead of drafting it";
        }
        if (!/send|"confirmed":true/i.test(secondBlob)) {
          const responseText = String(ctx.turns?.[1]?.responseText ?? "");
          if (!/\bsent\b|\bsending\b/i.test(responseText)) {
            return "second turn did not clearly send the Signal reply after confirmation";
          }
        }
      },
    },
    {
      type: "custom",
      name: "signal-reply-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "signal draft then send",
        includesAny: ["signal", "draft", "send", "reply"],
        minCount: 2,
      }),
    },
    judgeRubric({
      name: "signal-reply-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted a Signal reply first and only sent it after the explicit confirmation turn.",
    }),
  ],
});
