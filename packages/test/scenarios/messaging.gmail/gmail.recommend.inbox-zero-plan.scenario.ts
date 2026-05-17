import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.recommend.inbox-zero-plan",
  title: "Recommend Gmail inbox-zero actions without writing",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "recommendations", "inbox-zero", "read-only"],
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
      title: "Gmail Inbox-Zero Recommendations",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: ["msg-julia", "msg-spam"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "recommend inbox-zero actions",
      room: "main",
      text: "Review my Gmail inbox and recommend what I should reply to, archive, mark read, or flag as spam. Do not change anything yet.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must produce a Gmail cleanup recommendation plan with separate reply, archive/mark-read, and spam-review categories. It must not claim it modified, archived, marked, reported, drafted, or sent anything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "recommend",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
    },
    {
      type: "gmailBatchModify",
      expected: false,
    },
    {
      type: "gmailDraftCreated",
      expected: false,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-inbox-zero-recommendation-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant used Gmail recommendations as a read-only planning step and kept all write operations out of the run.",
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
