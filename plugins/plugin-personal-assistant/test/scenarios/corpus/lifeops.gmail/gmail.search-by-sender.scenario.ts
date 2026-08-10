/**
 * Gmail search-by-sender — agent issues a curated Gmail MCP search with a
 * `from:` operator when the user asks "what did Sarah send me?".
 *
 * Failure modes guarded:
 *   - full-inbox scan instead of targeted search
 *   - missing `q=from:` operator
 *   - fabricating Sarah's mail
 *
 * Cited: 03-coverage-gap-matrix.md — search-by-sender.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  GMAIL_MCP_WRITE_TOOLS,
  gmailSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.search-by-sender",
  title: "Gmail search by sender uses from: operator",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "search", "sender"],
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
      title: "Gmail Search By Sender",
    },
  ],
  seed: [gmailSearchFixture([GMAIL_MCP_MESSAGES.sarahProductBrief])],
  turns: [
    {
      kind: "message",
      name: "search-from-sarah",
      room: "main",
      text: "What has Sarah sent me recently? Just from her.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must specifically reference mail from Sarah using a targeted search, not enumerate the whole inbox.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
      arguments: { query: "from:sarah" },
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
      name: "gmail-search-by-sender-rubric",
      threshold: 0.7,
      description:
        "Agent searched Gmail by sender and summarized Sarah's mail specifically without listing unrelated inbox.",
    }),
  ],
});
