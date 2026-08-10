/**
 * Gmail list-unread — agent must call the curated search tool with an unread
 * filter that bounds "this morning" to a sane window.
 *
 * Failure modes guarded:
 *   - listing ALL mail instead of unread only
 *   - listing without a date bound (fetches months back)
 *   - claiming a count without calling the MCP tool
 *
 * Cited: 03-coverage-gap-matrix.md — list unread with time bound.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_WRITE_TOOLS,
  gmailDefaultSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.list-unread-this-morning",
  title: "List unread Gmail from this morning, bounded query",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "list", "unread", "time-bound"],
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
      title: "Gmail List Unread Morning",
    },
  ],
  seed: [gmailDefaultSearchFixture()],
  turns: [
    {
      kind: "message",
      name: "list-unread-morning",
      room: "main",
      text: "What unread email came in this morning?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must list or summarize unread messages from a recent time window, not claim the inbox is empty when fixture rows exist.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
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
      name: "gmail-list-unread-morning-rubric",
      threshold: 0.7,
      description:
        "Agent listed unread Gmail bounded to this morning through the curated search_threads MCP tool, without drafting or changing labels.",
    }),
  ],
});
