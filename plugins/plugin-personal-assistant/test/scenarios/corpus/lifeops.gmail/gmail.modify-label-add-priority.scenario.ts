/**
 * Apply a label to a single Gmail message through label_message.
 *
 * Failure modes guarded:
 *   - skipping the modify call entirely
 *   - applying label to wrong message
 *   - skipping approval gate
 *
 * Cited: 03-coverage-gap-matrix.md — single-message label apply.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  gmailGetMessageFixture,
  gmailMcpFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

const TARGET = "msg-julia";

export default scenario({
  lane: "live-only",
  id: "gmail.modify-label-add-priority",
  title: "Add Priority label to a specific Gmail message",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "label", "modify"],
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
      title: "Gmail Add Priority Label",
    },
  ],
  seed: [
    gmailGetMessageFixture(GMAIL_MCP_MESSAGES.juliaAttachment),
    gmailMcpFixture({
      tool: "label_message",
      arguments: { messageId: TARGET, labelIds: ["Priority"] },
      structuredContent: {
        messageId: TARGET,
        addedLabelIds: ["Priority"],
      },
      clearLedger: false,
    }),
  ],
  turns: [
    {
      kind: "message",
      name: "identify-target",
      room: "main",
      text: `Find the message ${TARGET} in Gmail and confirm what it is.`,
      responseJudge: {
        minimumScore: 0.7,
        rubric: "Reply must identify the specific message, not a broad list.",
      },
    },
    {
      kind: "message",
      name: "apply-label",
      room: "main",
      text: "Now apply the 'Priority' label to that message only.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must bind the label apply to the previously identified message. Must not label other messages.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "label_message",
      arguments: { messageId: TARGET, labelIds: ["Priority"] },
    },
    judgeRubric({
      name: "gmail-modify-label-rubric",
      threshold: 0.7,
      description:
        "Agent applied Priority to the identified message through label_message without drafting.",
    }),
  ],
});
