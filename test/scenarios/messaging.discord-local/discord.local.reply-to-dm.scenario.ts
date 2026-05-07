import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "discord.local.reply-to-dm",
  title: "Reply to Discord DM with confirmation",
  domain: "messaging.discord-local",
  tags: ["messaging", "discord", "confirmation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Discord Local Reply",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft reply",
      room: "main",
      text: "Draft a reply to the latest Discord DM from Bob saying I'll be there soon.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["TRIAGE_MESSAGES", "SEND_DRAFT"],
        description: "discord DM draft reply",
        includesAny: ["discord", "Bob", "draft", "reply"],
      }),
      responseIncludesAny: ["draft", "bob", "reply"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 1 must produce a Discord draft reply to Bob and hold it instead of claiming it was already sent.",
      },
    },
    {
      kind: "message",
      name: "confirm send",
      room: "main",
      text: "Send it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["TRIAGE_MESSAGES", "SEND_DRAFT"],
        description: "discord DM send after confirmation",
        includesAny: ["send", "discord", "reply"],
      }),
      responseIncludesAny: ["sent", "sending", "send"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 2 must reflect that the drafted Discord reply is being sent because the user explicitly confirmed it.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["TRIAGE_MESSAGES", "SEND_DRAFT"],
    },
    {
      type: "custom",
      name: "discord-local-reply-two-step-gate",
      predicate: async (ctx) => {
        const firstBlob = JSON.stringify(ctx.turns?.[0]?.actionsCalled ?? []);
        const secondBlob = JSON.stringify(ctx.turns?.[1]?.actionsCalled ?? []);
        if (
          /send|"confirmed":true/i.test(firstBlob) &&
          !/draft/i.test(firstBlob)
        ) {
          return "first turn appears to have sent the Discord reply instead of drafting it";
        }
        if (!/send|"confirmed":true/i.test(secondBlob)) {
          const responseText = String(ctx.turns?.[1]?.responseText ?? "");
          if (!/\bsent\b|\bsending\b/i.test(responseText)) {
            return "second turn did not clearly send the Discord reply after confirmation";
          }
        }
      },
    },
    {
      type: "custom",
      name: "discord-local-reply-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["TRIAGE_MESSAGES", "SEND_DRAFT"],
        description: "discord DM draft then send",
        includesAny: ["discord", "draft", "send", "reply"],
        minCount: 2,
      }),
    },
    {
      type: "custom",
      name: "discord-local-reply-send-target-and-payload",
      predicate: async (ctx) => {
        const sendAction = [...ctx.actionsCalled]
          .reverse()
          .find((entry) => entry.actionName === "SEND_DRAFT");
        if (!sendAction) {
          return "expected a SEND_DRAFT action for the confirmed Discord reply";
        }

        const blob = JSON.stringify(sendAction).toLowerCase();
        if (!blob.includes("discord")) {
          return "expected the confirmed reply send payload to target Discord";
        }
        if (!blob.includes("bob")) {
          return "expected the confirmed Discord reply send payload to preserve Bob as the DM target";
        }
        if (!/there soon|be there|i'?ll be there/.test(blob)) {
          return "expected the confirmed Discord reply payload to include the typed reply text";
        }
        return undefined;
      },
    },
    judgeRubric({
      name: "discord-local-reply-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted a Discord DM reply first and only sent it after the explicit confirmation turn.",
    }),
  ],
});
