import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "whatsapp.reply",
  title: "Reply to WhatsApp message with confirmation",
  domain: "messaging.whatsapp",
  tags: ["messaging", "whatsapp", "confirmation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "WhatsApp Reply",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft whatsapp reply",
      room: "main",
      text: "Reply on WhatsApp to Eve saying see you at 7.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "whatsapp draft reply",
        includesAny: ["whatsapp", "Eve", "draft", "reply"],
      }),
      responseIncludesAny: ["whatsapp", "eve", "draft"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 1 must produce a WhatsApp draft reply to Eve and keep it unsent until confirmation.",
      },
    },
    {
      kind: "message",
      name: "confirm send",
      room: "main",
      text: "Send it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "whatsapp send after confirmation",
        includesAny: ["send", "whatsapp", "reply"],
      }),
      responseIncludesAny: ["sent", "sending", "send"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 2 must reflect that the drafted WhatsApp reply is now being sent because the user explicitly confirmed it.",
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
      name: "whatsapp-reply-two-step-gate",
      predicate: async (ctx) => {
        const firstBlob = JSON.stringify(ctx.turns?.[0]?.actionsCalled ?? []);
        const secondBlob = JSON.stringify(ctx.turns?.[1]?.actionsCalled ?? []);
        if (
          /send|"confirmed":true/i.test(firstBlob) &&
          !/draft/i.test(firstBlob)
        ) {
          return "first turn appears to have sent the WhatsApp reply instead of drafting it";
        }
        if (!/send|"confirmed":true/i.test(secondBlob)) {
          const responseText = String(ctx.turns?.[1]?.responseText ?? "");
          if (!/\bsent\b|\bsending\b/i.test(responseText)) {
            return "second turn did not clearly send the WhatsApp reply after confirmation";
          }
        }
      },
    },
    {
      type: "custom",
      name: "whatsapp-reply-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "whatsapp draft then send",
        includesAny: ["whatsapp", "draft", "send", "reply"],
        minCount: 2,
      }),
    },
    {
      type: "custom",
      name: "whatsapp-reply-send-payload-is-addressed",
      predicate: async (ctx) => {
        const sendActions = ctx.actionsCalled.filter((action) =>
          ["MESSAGE", "MESSAGE"].includes(
            action.actionName,
          ),
        );
        const confirmedSends = sendActions.filter((action) => {
          const blob = JSON.stringify(action).toLowerCase();
          return blob.includes("whatsapp") && /send|sent|confirmed/.test(blob);
        });
        if (confirmedSends.length === 0) {
          return "expected a confirmed WhatsApp send action after the user approved the draft";
        }

        const blob = JSON.stringify(confirmedSends).toLowerCase();
        if (!blob.includes("eve")) {
          return "expected the WhatsApp send payload to address Eve";
        }
        if (!blob.includes("see you at 7")) {
          return "expected the WhatsApp send payload to include the approved reply text";
        }
      },
    },
    judgeRubric({
      name: "whatsapp-reply-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted a WhatsApp reply first and only sent it after the explicit confirmation turn.",
    }),
  ],
});
