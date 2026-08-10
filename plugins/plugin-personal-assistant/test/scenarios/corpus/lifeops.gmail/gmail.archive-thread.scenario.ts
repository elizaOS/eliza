/**
 * Archive a Gmail THREAD (not a single message) — the archive must apply to
 * every message in the thread through the official unlabel_thread tool.
 *
 * Failure modes guarded:
 *   - archiving only the latest message in the thread
 *   - leaving the thread visible in inbox
 *
 * Cited: 03-coverage-gap-matrix.md — thread archive.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  gmailMcpFixture,
  gmailSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
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
    gmailSearchFixture([GMAIL_MCP_MESSAGES.newsletter]),
    gmailMcpFixture({
      tool: "unlabel_thread",
      arguments: {
        threadId: GMAIL_MCP_MESSAGES.newsletter.threadId,
        labelIds: ["INBOX"],
      },
      structuredContent: {
        threadId: GMAIL_MCP_MESSAGES.newsletter.threadId,
        removedLabelIds: ["INBOX"],
      },
      clearLedger: false,
    }),
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
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "unlabel_thread",
      arguments: {
        threadId: GMAIL_MCP_MESSAGES.newsletter.threadId,
        labelIds: ["INBOX"],
      },
    },
    judgeRubric({
      name: "gmail-archive-thread-rubric",
      threshold: 0.7,
      description:
        "Agent archived the entire thread through unlabel_thread by removing the INBOX label, without drafting anything.",
    }),
  ],
});
