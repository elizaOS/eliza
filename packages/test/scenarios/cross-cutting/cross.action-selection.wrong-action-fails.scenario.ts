/**
 * Action-selection test: 'Set a reminder to call mom tomorrow at 3pm' must
 * route to an appropriate reminder/task action. Both CREATE_TASK and
 * SCHEDULE_FOLLOW_UP are valid action-catalog entries; either is accepted.
 *
 * Fails if neither fires, which would mean the agent is handling reminder
 * intent as plain chat.
 */

import { scenario } from "@elizaos/scenario-schema";

const ACCEPTED_REMINDER_ACTIONS = ["CREATE_TASK", "SCHEDULE_FOLLOW_UP", "LIFE"];

export default scenario({
  id: "cross.action-selection.wrong-action-fails",
  title: "Reminder request routes to a reminder/task action",
  domain: "cross-cutting",
  tags: ["cross-cutting", "critical", "ambiguity"],
  description:
    "User asks to set a reminder. The agent must invoke one of the valid reminder-shaped actions (CREATE_TASK, SCHEDULE_FOLLOW_UP, or LIFE). REPLY alone is not sufficient — that would mean the agent acknowledged the request verbally but did nothing.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: reminder routing",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "reminder-request",
      room: "main",
      text: "Set a reminder to call mom tomorrow at 3pm",
      responseJudge: {
        rubric:
          "Response confirms the reminder was set up for tomorrow at 3pm to call mom.",
        minimumScore: 0.7,
      },
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find((a) =>
          ACCEPTED_REMINDER_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected one of [${ACCEPTED_REMINDER_ACTIONS.join(", ")}] but got: ${fired}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "reminder-action-fired",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((a) =>
          ACCEPTED_REMINDER_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          return `No reminder-shaped action fired. Accepted: ${ACCEPTED_REMINDER_ACTIONS.join(", ")}`;
        }
      },
    },
  ],
});
