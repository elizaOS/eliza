/**
 * Thread view — when the user asks to "show me the whole thread", the
 * agent must hit the thread/get endpoint (not just messages/get for one
 * message) and return all messages in chronological order.
 *
 * Failure modes guarded:
 *   - returning only the latest message
 *   - returning thread out of order
 *
 * Cited: 03-coverage-gap-matrix.md — full-thread view.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  GMAIL_MCP_WRITE_TOOLS,
  gmailMcpFixture,
  gmailSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

const JULIA_THREAD_MESSAGES = [
  {
    ...GMAIL_MCP_MESSAGES.juliaAttachment,
    id: "msg-julia-opening",
    snippet: "Can you send the updated launch packet?",
    plaintextBody: "Can you send the updated launch packet?",
    date: "2026-08-09T15:00:00.000Z",
  },
  GMAIL_MCP_MESSAGES.juliaAttachment,
];

export default scenario({
  lane: "live-only",
  id: "gmail.thread-view-shows-full-history",
  title: "Gmail thread view fetches full message history",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "thread", "history"],
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
      title: "Gmail Thread Full History",
    },
  ],
  seed: [
    gmailSearchFixture(JULIA_THREAD_MESSAGES),
    gmailMcpFixture({
      tool: "get_thread",
      arguments: { threadId: GMAIL_MCP_MESSAGES.juliaAttachment.threadId },
      structuredContent: {
        thread: {
          id: GMAIL_MCP_MESSAGES.juliaAttachment.threadId,
          messages: JULIA_THREAD_MESSAGES,
        },
      },
      clearLedger: false,
    }),
  ],
  turns: [
    {
      kind: "message",
      name: "show-thread-history",
      room: "main",
      text: "Show me the entire email thread with Julia from start to finish, in order.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must show or summarize multiple messages in the thread (not just one), in chronological order.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "get_thread",
      arguments: {
        threadId: GMAIL_MCP_MESSAGES.juliaAttachment.threadId,
      },
      minCount: 1,
    },
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: GMAIL_MCP_WRITE_TOOLS,
      expected: false,
    },
    judgeRubric({
      name: "gmail-thread-history-rubric",
      threshold: 0.7,
      description:
        "Agent fetched the full Julia thread through get_thread and summarized messages in order, not just the latest.",
    }),
  ],
});
