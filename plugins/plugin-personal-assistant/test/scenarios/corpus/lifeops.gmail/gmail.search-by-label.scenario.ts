/**
 * Gmail search-by-label — `label:` operator search.
 *
 * Failure modes guarded:
 *   - searching all mail instead of label-bound
 *   - fabricating labels that don't exist
 *
 * Cited: 03-coverage-gap-matrix.md — label-bound search.
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
  id: "gmail.search-by-label",
  title: "Gmail search by label uses label: operator",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "search", "label"],
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
      title: "Gmail Search By Label",
    },
  ],
  seed: [gmailSearchFixture([GMAIL_MCP_MESSAGES.financeAlert])],
  turns: [
    {
      kind: "message",
      name: "search-by-label-finance",
      room: "main",
      text: "Show me everything in Gmail labeled 'Finance'.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must scope the search to the Finance label and not enumerate unrelated mail. May honestly report 'no matches'.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
      arguments: { query: "label:Finance" },
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
      name: "gmail-search-by-label-rubric",
      threshold: 0.7,
      description:
        "Agent searched within the Finance label scope and produced label-specific results without leaking unrelated mail.",
    }),
  ],
});
