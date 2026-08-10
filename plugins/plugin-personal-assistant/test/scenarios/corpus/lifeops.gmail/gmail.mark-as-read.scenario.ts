/**
 * Mark a Gmail newsletter as read through unlabel_message with `UNREAD`
 * removed.
 *
 * Failure modes guarded:
 *   - sending mark-read to wrong messages
 *   - skipping the modify call
 *
 * Cited: 03-coverage-gap-matrix.md — mark-as-read.
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
    gmailSearchFixture([GMAIL_MCP_MESSAGES.newsletter]),
    gmailMcpFixture({
      tool: "unlabel_message",
      arguments: {
        messageId: GMAIL_MCP_MESSAGES.newsletter.id,
        labelIds: ["UNREAD"],
      },
      structuredContent: {
        messageId: GMAIL_MCP_MESSAGES.newsletter.id,
        removedLabelIds: ["UNREAD"],
      },
      clearLedger: false,
    }),
  ],
  turns: [
    {
      kind: "message",
      name: "mark-newsletter-read",
      room: "main",
      text: "Mark the unread Weekly Digest newsletter as read so it stops showing up at the top.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must scope mark-read to newsletters and not enumerate sending/drafting.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "unlabel_message",
      arguments: {
        messageId: GMAIL_MCP_MESSAGES.newsletter.id,
        labelIds: ["UNREAD"],
      },
    },
    judgeRubric({
      name: "gmail-mark-as-read-rubric",
      threshold: 0.7,
      description:
        "Agent removed the UNREAD label from the named newsletter through unlabel_message without other side effects.",
    }),
  ],
});
