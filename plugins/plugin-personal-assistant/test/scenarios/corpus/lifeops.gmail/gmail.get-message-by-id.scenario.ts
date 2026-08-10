/**
 * Gmail get message by id — agent fetches a specific message through the
 * curated `get_message` MCP tool when given an explicit ID.
 *
 * Failure modes guarded:
 *   - calling list then filtering (wasteful, fragile)
 *   - fabricating the body without calling the MCP tool
 *
 * Cited: 03-coverage-gap-matrix.md — single-message fetch by id.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  GMAIL_MCP_WRITE_TOOLS,
  gmailGetMessageFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

const MESSAGE_ID = "msg-julia";

export default scenario({
  lane: "live-only",
  id: "gmail.get-message-by-id",
  title: "Get a specific Gmail message by ID through curated MCP",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "get", "lookup"],
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
      title: "Gmail Get By ID",
    },
  ],
  seed: [gmailGetMessageFixture(GMAIL_MCP_MESSAGES.juliaAttachment)],
  turns: [
    {
      kind: "message",
      name: "ask-for-message-by-id",
      room: "main",
      text: `Pull up Gmail message ${MESSAGE_ID} and tell me what it says.`,
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must describe message contents fetched through get_message, not invent content. Reply must reference the actual message.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "get_message",
      arguments: { messageId: MESSAGE_ID },
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
      name: "gmail-get-by-id-rubric",
      threshold: 0.7,
      description:
        "Agent fetched the specific Gmail message ID through get_message and described its actual contents without fabricating.",
    }),
  ],
});
