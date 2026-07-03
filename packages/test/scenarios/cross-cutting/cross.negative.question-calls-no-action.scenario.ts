/**
 * Action-selection negative test: a trivia question must be answered
 * conversationally, not routed into any side-effect action (no task creation,
 * no follow-up scheduling, no contact add, no outbound message).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoActionCalled } from "../_helpers/effect-assertions.ts";

const FORBIDDEN_SIDE_EFFECTS = [
  "MESSAGE",
  "CREATE_TASK",
  "SCHEDULE_FOLLOW_UP",
  "ADD_CONTACT",
  "WEBSITE_BLOCK",
  "APP_BLOCK",
] as const;

function expectTriviaReplyOnly(ctx: ScenarioContext): string | undefined {
  const forbidden = expectNoActionCalled(ctx, FORBIDDEN_SIDE_EFFECTS);
  if (forbidden) return forbidden;

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (!/paris/i.test(reply)) {
    return `expected trivia response to answer Paris, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "cross.negative.question-calls-no-action",
  title: "Trivia question is answered without side-effect actions",
  domain: "cross-cutting",
  tags: ["cross-cutting", "negative", "critical"],
  description:
    "'What is the capital of France?' must be answered in the response text (Paris) without the agent firing MESSAGE, CREATE_TASK, SCHEDULE_FOLLOW_UP, or ADD_CONTACT.",

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
      forbiddenActions: [...FORBIDDEN_SIDE_EFFECTS],
      responseIncludesAny: ["Paris", "paris"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "trivia-reply-without-side-effects",
      predicate: expectTriviaReplyOnly,
    },
  ],
});
