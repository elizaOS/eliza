/**
 * Action-selection negative test: a casual greeting must not trigger any
 * side-effect action (message-send, task-create, follow-up schedule, contact
 * add). REPLY is allowed since it is the plain conversational response action.
 *
 * Scope: verifies the agent's action-selection pipeline, independent of any
 * particular plugin/domain.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "cross.negative.greeting-calls-no-action",
  title: "Casual greeting triggers REPLY only — no side-effect actions",
  domain: "cross-cutting",
  tags: ["cross-cutting", "negative", "critical", "happy-path"],
  description:
    "A plain 'good morning' greeting must not call MESSAGE, MESSAGE, SCHEDULE_FOLLOW_UP, CREATE_TASK, or any other side-effect action. The agent should respond conversationally via REPLY.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: greeting",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "user-greeting",
      room: "main",
      text: "Hey, good morning!",
      forbiddenActions: [
        "MESSAGE",
        "MESSAGE",
        "SCHEDULE_FOLLOW_UP",
        "CREATE_TASK",
        "ADD_CONTACT",
        "WEBSITE_BLOCK",
        "APP_BLOCK",
      ],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "Expected a non-empty conversational response to a greeting";
        }
      },
    },
  ],

  finalChecks: [
    {
      // The agent must produce a conversational response. We accept the
      // canonical REPLY action, or any action whose result carried text back
      // to the user (some domain actions route small-talk through their own
      // handler and still emit a text reply, which satisfies the spirit of
      // this test: no destructive side-effects + a text response).
      type: "custom",
      name: "conversational-response",
      predicate: async (ctx) => {
        const replied = ctx.actionsCalled.some(
          (a) =>
            a.actionName === "REPLY" ||
            (typeof a.result?.text === "string" &&
              a.result.text.trim().length > 0),
        );
        if (!replied) {
          const fired =
            ctx.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected a conversational response; got: ${fired}`;
        }
      },
    },
  ],
});
