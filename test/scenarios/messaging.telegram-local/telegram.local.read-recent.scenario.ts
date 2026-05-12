import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "telegram.local.read-recent",
  title: "Read recent Telegram messages via local plugin",
  domain: "messaging.telegram-local",
  tags: ["messaging", "telegram", "happy-path", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Telegram Local Read",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read telegram",
      room: "main",
      text: "What's new on Telegram?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["INBOX"],
        description: "telegram chat read",
        includesAny: ["telegram", "message", "chat"],
      }),
      responseIncludesAny: ["telegram", "message", "chat"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must summarize or acknowledge Telegram chat content. A generic 'I checked Telegram' response without chat context fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "INBOX",
    },
    {
      type: "selectedActionArguments",
      actionName: "INBOX",
      includesAny: ["telegram", "message", "chat"],
    },
    {
      type: "custom",
      name: "telegram-local-read-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["INBOX"],
        description: "telegram chat read",
        includesAny: ["telegram", "message", "chat"],
      }),
    },
    judgeRubric({
      name: "telegram-local-read-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant read recent Telegram chat activity and surfaced useful context instead of a generic acknowledgement.",
    }),
  ],
});
