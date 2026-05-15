/**
 * Archive a Gmail THREAD (not a single message) — the archive must apply to
 * every message in the thread, exercised via the threads/modify mock or
 * batchModify across thread messages.
 *
 * Failure modes guarded:
 *   - archiving only the latest message in the thread
 *   - leaving the thread visible in inbox
 *
 * Cited: 03-coverage-gap-matrix.md — thread archive.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.archive-thread",
  title: "Archive a Gmail thread (all messages)",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "archive", "thread"],
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
      title: "Gmail Archive Thread",
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
      name: "archive-thread",
      room: "main",
      text: "Archive the entire Weekly Digest thread, not just the latest message.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must confirm archiving the entire thread, not a single message. Reply must not claim to send anything.",
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
      name: "gmail-archive-thread-rubric",
      threshold: 0.7,
      description:
        "Agent archived the entire thread via batchModify (removing INBOX label across thread messages) without sending or drafting.",
    }),
  ],
});
