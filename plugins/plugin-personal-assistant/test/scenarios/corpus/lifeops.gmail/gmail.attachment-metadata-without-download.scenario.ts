/**
 * Attachment metadata — the agent must surface the attachment filename from
 * message metadata WITHOUT downloading the attachment bytes (no
 * `attachments/get` call required if the user only asked "what's attached").
 *
 * Failure modes guarded:
 *   - downloading attachments wholesale when metadata suffices
 *   - fabricating attachment names that aren't in the fixture
 *
 * Cited: 03-coverage-gap-matrix.md — attachment metadata.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  GMAIL_MCP_WRITE_TOOLS,
  gmailGetMessageFixture,
  gmailSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.attachment-metadata-without-download",
  title: "Attachment metadata surfaced without downloading bytes",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "attachment", "metadata"],
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
      title: "Gmail Attachment Metadata",
    },
  ],
  seed: [
    gmailSearchFixture([GMAIL_MCP_MESSAGES.juliaAttachment]),
    gmailGetMessageFixture(GMAIL_MCP_MESSAGES.juliaAttachment, {
      clearLedger: false,
    }),
  ],
  turns: [
    {
      kind: "message",
      name: "ask-attachment-meta",
      room: "main",
      text: "What attachments are on the most recent message from Julia? Just the filenames — don't open them.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must list attachment filename(s) from message metadata, not fabricate or claim to have opened the file.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "get_message",
      arguments: { messageId: GMAIL_MCP_MESSAGES.juliaAttachment.id },
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
      name: "gmail-attachment-metadata-rubric",
      threshold: 0.7,
      description:
        "Agent reported attachment metadata from get_message without downloading bytes or fabricating filenames.",
    }),
  ],
});
