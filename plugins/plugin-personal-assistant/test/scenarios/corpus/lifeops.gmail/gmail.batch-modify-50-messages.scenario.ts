/**
 * The curated Gmail MCP has no bulk REST mutation. A request to archive about
 * 50 messages in one operation must be refused without N individual writes.
 *
 * Failure modes guarded:
 *   - one modify call per message (50x quota usage)
 *   - skipping the modify entirely
 *
 * Cited: 03-coverage-gap-matrix.md — batch-modify scale.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_WRITE_TOOLS,
  gmailDefaultSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.batch-modify-50-messages",
  title: "Unsupported bulk Gmail archive is refused without per-message writes",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "batch", "scale", "quota"],
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
      title: "Gmail Batch Modify Scale",
    },
  ],
  seed: [gmailDefaultSearchFixture()],
  turns: [
    {
      kind: "message",
      name: "bulk-archive-50",
      room: "main",
      text: "Archive every newsletter, promotion, and notification email in my inbox in one operation. There are about 50 of them.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must explain that one-operation bulk archive is unavailable through the curated Gmail MCP, must not claim success, and must not fan out into individual writes.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: GMAIL_MCP_WRITE_TOOLS,
      expected: false,
    },
    judgeRubric({
      name: "gmail-batch-50-rubric",
      threshold: 0.7,
      description:
        "Agent refused the unavailable bulk REST mutation and made no individual Gmail MCP writes.",
    }),
  ],
});
