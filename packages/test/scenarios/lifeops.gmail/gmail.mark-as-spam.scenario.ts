/**
 * Mark a single Gmail message as spam — exercise batchModify add `SPAM`.
 *
 * Failure modes guarded:
 *   - bulk-spamming the whole inbox
 *   - skipping confirmation gate for destructive op
 *
 * Cited: 03-coverage-gap-matrix.md — mark-as-spam single message.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const SPAM_TARGET = "msg-spam";

export default scenario({
  id: "gmail.mark-as-spam",
  title: "Mark a specific Gmail message as spam via batchModify add SPAM",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "spam", "modify"],
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
      title: "Gmail Mark As Spam",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: [SPAM_TARGET],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "find-spam-candidate",
      room: "main",
      text: `Find the message ${SPAM_TARGET} in Gmail and tell me what it is.`,
      responseJudge: {
        minimumScore: 0.7,
        rubric: "Reply must identify the suspicious message individually.",
      },
    },
    {
      kind: "message",
      name: "mark-spam",
      room: "main",
      text: "Mark that one as spam — just that one.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must scope the spam-mark to the previously identified message only.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailBatchModify",
      body: {
        addLabelIds: "MESSAGE",
      },
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailDraftCreated",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-mark-as-spam-rubric",
      threshold: 0.7,
      description:
        "Agent marked the targeted message as spam via batchModify (add SPAM label) without bulk-spamming or sending.",
    }),
  ],
});
