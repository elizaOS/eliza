import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.bulk.archive-newsletters",
  title: "Bulk archive selected Gmail newsletter",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "bulk", "archive", "inbox-zero"],
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
      title: "Gmail Archive Newsletter",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: ["msg-newsletter"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "locate newsletter",
      room: "main",
      text: "Find the Weekly Digest newsletter in Gmail and verify it is the automated digest, not a person or invoice.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must locate the Weekly Digest newsletter and distinguish it from person-to-person mail or invoice mail.",
      },
    },
    {
      kind: "message",
      name: "archive newsletter",
      room: "main",
      text: "Archive that newsletter now, and only that newsletter.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must bind the archive operation to the newsletter selected in the previous step. It must not archive person-to-person messages, finance mail, spam, or unrelated inbox items.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: ["search", "read"],
      minCount: 1,
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "manage",
      operation: "archive",
    },
    {
      type: "gmailBatchModify",
      body: {
        removeLabelIds: "MESSAGE",
      },
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
      name: "gmail-archive-newsletter-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant resolved the newsletter target first and then archived only that Gmail message through the mock batchModify write.",
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
