import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "whatsapp.read",
  title: "Read recent WhatsApp messages",
  domain: "messaging.whatsapp",
  tags: ["messaging", "whatsapp", "happy-path", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "WhatsApp Read",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read whatsapp",
      room: "main",
      text: "What's new on WhatsApp?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "whatsapp chat read",
        includesAny: ["whatsapp", "message", "chat"],
      }),
      responseIncludesAny: ["whatsapp", "message", "chat"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must summarize or acknowledge recent WhatsApp chat content. A generic statement that WhatsApp was checked without chat context fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "selectedActionArguments",
      actionName: "MESSAGE",
      includesAny: ["whatsapp", "message", "chat"],
    },
    {
      type: "custom",
      name: "whatsapp-read-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "whatsapp chat read",
        includesAny: ["whatsapp", "message", "chat"],
      }),
    },
    {
      type: "custom",
      name: "whatsapp-read-requires-channel-context",
      predicate: async (ctx) => {
        const inboxActions = ctx.actionsCalled.filter((action) =>
          ["MESSAGE", "MESSAGE"].includes(action.actionName),
        );
        const blob = JSON.stringify(inboxActions).toLowerCase();
        if (!blob.includes("whatsapp")) {
          return "expected the inbox read to be scoped to WhatsApp";
        }
        if (!/(chat|thread|room|message)/i.test(blob)) {
          return "expected WhatsApp chat/message context in the inbox read payload";
        }
      },
    },
    judgeRubric({
      name: "whatsapp-read-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant surfaced recent WhatsApp chat context instead of a generic acknowledgement.",
    }),
  ],
});
