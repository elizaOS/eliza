import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.search.spam-trash",
  title: "Search Gmail spam and trash without modifying messages",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "search", "spam", "read-only"],
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
      title: "Gmail Spam Search",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: ["msg-spam"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read spam notice",
      room: "main",
      text: "Look in Gmail spam or trash for the suspicious account notice and read it. Do not report it, delete it, archive it, or mark it read.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must search or read Gmail spam/trash content, identify the synthetic account notice, and keep the run read-only. Any claim that it reported, deleted, archived, marked read, replied, or sent fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: ["search", "read"],
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
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
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-spam-search-readonly-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant looked in Gmail spam/trash and read the matching message without performing any Gmail write.",
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
