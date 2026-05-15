/**
 * Multi-action chain: create a todo, then block named sites. Verifies the agent
 * can sequence two distinct side-effect actions across turns while maintaining
 * conversational context.
 *
 * Turn 1: CREATE_TASK (or LIFE simile) fires for the push-up todo.
 * Turn 2: WEBSITE_BLOCK fires for the requested hostnames.
 */

import { scenario } from "@elizaos/scenario-schema";

const TODO_CREATE_ACTIONS = ["CREATE_TASK", "LIFE"];

export default scenario({
  id: "cross.multi-action-chain.create-todo-then-block-sites",
  title: "Create todo, then block social media until it's done",
  domain: "cross-cutting",
  tags: ["cross-cutting", "multi-action", "critical"],
  description:
    "Two-turn chain: user asks the agent to create a push-ups todo, then in the follow-up turn asks to block named sites. Verifies CREATE_TASK (or LIFE) fires on turn 1 and WEBSITE_BLOCK fires on turn 2.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: multi-action chain",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "create-todo",
      room: "main",
      text: "Create a todo: 'do 50 push-ups'",
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find((a) =>
          TODO_CREATE_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected one of [${TODO_CREATE_ACTIONS.join(", ")}] but got: ${fired}`;
        }
      },
    },
    {
      kind: "message",
      name: "block-until-complete",
      room: "main",
      text: "Now block x.com, instagram.com, and reddit.com until I finish it",
      content: {
        websites: ["x.com", "instagram.com", "reddit.com"],
        todoName: "do 50 push-ups",
      },
      assertTurn: (turn) => {
        const blocked = turn.actionsCalled.find(
          (a) => a.actionName === "WEBSITE_BLOCK",
        );
        if (!blocked) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected WEBSITE_BLOCK action but got: ${fired}`;
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
});
