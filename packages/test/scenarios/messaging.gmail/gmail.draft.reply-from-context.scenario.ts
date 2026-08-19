/** Scenario fixture for gmail draft reply from context; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { gmailExactDraftBinding } from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.draft.reply-from-context",
  title: "Draft Gmail reply using recent email context",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "draft", "happy-path"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Gmail Draft Reply",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "sarah-product-brief.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft reply to sarah",
      room: "main",
      text: "Draft a reply to Sarah's latest email saying I can review it Friday afternoon, but don't send it yet.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must present a draft email to Sarah that includes the Friday-afternoon availability and must not claim it was already sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: "draft_reply",
      turn: "draft reply to sarah",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg-sarah",
      minCount: 1,
      turn: "draft reply to sarah",
    },
    {
      type: "gmailDraftCreated",
      turn: "draft reply to sarah",
    },
    {
      type: "gmailMessageSent",
      expected: false,
      turn: "draft reply to sarah",
    },
    {
      type: "gmailNoRealWrite",
    },
    gmailExactDraftBinding({
      name: "Sarah draft is bound to exact source and dictated body",
      turn: "draft reply to sarah",
      sourceMessageId: "msg-sarah",
      bodyIncludesAll: ["Friday afternoon"],
    }),
    judgeRubric({
      name: "gmail-draft-reply-from-context-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant read msg-sarah, created one local Gmail draft bound to that exact source and Friday-afternoon body, and made no provider send request.",
    }),
  ],
  cleanup: [
    {
      type: "gmailDeleteDrafts",
      account: "test-owner",
      tag: "eliza-e2e",
    },
  ],
});
