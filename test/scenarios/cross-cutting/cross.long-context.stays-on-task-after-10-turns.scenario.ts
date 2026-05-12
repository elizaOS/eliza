/**
 * Long-context test: 10 turns of small talk, then the user pivots to a
 * concrete request — listing todos. The agent must route to the task-
 * listing action. LIST_TASKS does not exist as a standalone action in
 * docs/action-catalog.md — it is a simile on LIFE — so we accept LIFE.
 */

import { scenario } from "@elizaos/scenario-schema";

const LIST_TASK_ACTIONS = ["LIFE", "LIST_TASKS"];

export default scenario({
  id: "cross.long-context.stays-on-task-after-10-turns",
  title: "Agent pivots back to a task-listing action after 10 turns of chat",
  domain: "cross-cutting",
  tags: ["cross-cutting", "long-context"],
  description:
    "10 turns of casual small talk, then a concrete request for today's todos. Verifies the agent can still route to the task-listing action after a long chat context. LIST_TASKS is a simile on LIFE, so either action name is accepted.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: long context",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "chat-1",
      room: "main",
      text: "Hey how's it going?",
    },
    {
      kind: "message",
      name: "chat-2",
      room: "main",
      text: "The weather is nice today.",
    },
    {
      kind: "message",
      name: "chat-3",
      room: "main",
      text: "Did you watch any good movies lately?",
    },
    {
      kind: "message",
      name: "chat-4",
      room: "main",
      text: "I think I might try that new cafe downtown.",
    },
    {
      kind: "message",
      name: "chat-5",
      room: "main",
      text: "What kinds of music do you like?",
    },
    {
      kind: "message",
      name: "chat-6",
      room: "main",
      text: "Traffic was terrible this morning.",
    },
    {
      kind: "message",
      name: "chat-7",
      room: "main",
      // NOTE: do NOT reference running/exercise/sleep/steps here — some
      // LifeOps actions route those to a health-bridge that throws when
      // no HealthKit/GoogleFit backend is configured. Keep the small talk
      // health-neutral so this scenario tests long-context pivot only.
      text: "That new bakery on Main Street has great pastries.",
    },
    {
      kind: "message",
      name: "chat-8",
      room: "main",
      text: "My cat keeps knocking things off the table.",
    },
    {
      kind: "message",
      name: "chat-9",
      room: "main",
      text: "Been reading a good book about gardening.",
    },
    {
      kind: "message",
      name: "chat-10",
      room: "main",
      text: "Anyway, enough about that.",
    },
    {
      kind: "message",
      name: "pivot-to-task-list",
      room: "main",
      text: "Okay, back to business — what todos do I have?",
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find((a) =>
          LIST_TASK_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected one of [${LIST_TASK_ACTIONS.join(", ")}] but got: ${fired}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "list-task-action-fired",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((a) =>
          LIST_TASK_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          return `No list-task action fired. Accepted: ${LIST_TASK_ACTIONS.join(", ")}`;
        }
      },
    },
  ],
});
