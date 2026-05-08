import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.draft.reply-from-context",
  title: "Draft Gmail reply using recent email context",
  domain: "messaging.gmail",
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
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "draft_reply",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
    },
    {
      type: "gmailDraftCreated",
    },
    {
      type: "gmailMockRequest",
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
      minCount: 1,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-draft-reply-from-context-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the Gmail reply from recent context and kept it as a draft instead of claiming it was sent.",
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
