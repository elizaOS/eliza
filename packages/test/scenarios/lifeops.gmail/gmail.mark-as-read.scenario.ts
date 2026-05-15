/**
 * Mark Gmail messages as read — exercises batchModify with `UNREAD` label
 * REMOVED.
 *
 * Failure modes guarded:
 *   - sending mark-read to wrong messages
 *   - skipping the modify call
 *
 * Cited: 03-coverage-gap-matrix.md — mark-as-read.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.mark-as-read",
  title: "Mark Gmail messages as read removes UNREAD label",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "mark-read", "modify"],
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
      title: "Gmail Mark As Read",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mark-newsletter-read",
      room: "main",
      text: "Mark all the unread newsletters as read so they stop showing up at the top.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must scope mark-read to newsletters and not enumerate sending/drafting.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailBatchModify",
      body: {
        removeLabelIds: "MESSAGE",
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
      name: "gmail-mark-as-read-rubric",
      threshold: 0.7,
      description:
        "Agent removed the UNREAD label from newsletters via batchModify mock without other side effects.",
    }),
  ],
});
