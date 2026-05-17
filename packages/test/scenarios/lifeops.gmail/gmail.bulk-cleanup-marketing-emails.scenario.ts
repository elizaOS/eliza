/**
 * Bulk-cleanup marketing emails — agent classifies and batch-archives
 * promotional/marketing mail without sending or drafting.
 *
 * Failure modes guarded:
 *   - archiving real-person mail
 *   - sending unsubscribe replies without approval
 *
 * Cited: 03-coverage-gap-matrix.md — bulk-cleanup marketing.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.bulk-cleanup-marketing-emails",
  title: "Bulk archive marketing emails without touching person mail",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "cleanup", "marketing", "bulk"],
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
      title: "Gmail Bulk Marketing Cleanup",
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
      name: "review-and-classify",
      room: "main",
      text: "Look through my inbox and identify which messages are marketing / promotional vs real person-to-person mail.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must distinguish marketing from person mail using inbox content.",
      },
    },
    {
      kind: "message",
      name: "archive-marketing-only",
      room: "main",
      text: "Archive the marketing batch only. Leave person mail alone.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must confirm archive is bound to the marketing batch identified earlier, not person mail. Must not send or draft.",
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
      name: "gmail-bulk-marketing-cleanup-rubric",
      threshold: 0.7,
      description:
        "Agent classified marketing vs person mail and archived only marketing via batchModify; did not send or touch person mail.",
    }),
  ],
});
