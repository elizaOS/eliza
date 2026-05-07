/**
 * Action-selection negative test: a trivia question must be answered
 * conversationally, not routed into any side-effect action (no task creation,
 * no follow-up scheduling, no contact add, no outbound message).
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "cross.negative.question-calls-no-action",
  title: "Trivia question is answered without side-effect actions",
  domain: "cross-cutting",
  tags: ["cross-cutting", "negative", "critical"],
  description:
    "'What is the capital of France?' must be answered in the response text (Paris) without the agent firing SEND_MESSAGE, CREATE_TASK, SCHEDULE_FOLLOW_UP, or ADD_CONTACT.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: trivia",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "user-trivia",
      room: "main",
      text: "What is the capital of France?",
      forbiddenActions: [
        "SEND_MESSAGE",
        "CREATE_TASK",
        "SCHEDULE_FOLLOW_UP",
        "ADD_CONTACT",
        "WEBSITE_BLOCK",
        "APP_BLOCK",
      ],
      responseIncludesAny: ["Paris", "paris"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
  ],
});
