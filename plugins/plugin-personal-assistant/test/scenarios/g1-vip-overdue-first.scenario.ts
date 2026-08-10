/**
 * G1 overdue backlog ranking: the assistant must inspect Gmail state, rank the
 * overdue reply backlog by relationship sensitivity, and avoid claiming any
 * message was sent while doing the triage.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  GMAIL_MCP_WRITE_TOOLS,
  gmailSearchFixture,
} from "../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "g1-vip-overdue-first",
  title: "G1 overdue reply backlog ranks relationship-sensitive threads first",
  domain: "lifeops.relationships",
  tags: ["lifeops", "gmail", "G1", "backlog", "priority", "outcome"],
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
      title: "G1 Overdue Backlog Ranking",
    },
  ],
  seed: [gmailSearchFixture([GMAIL_MCP_MESSAGES.overdueFollowup])],
  turns: [
    {
      kind: "message",
      name: "rank overdue reply backlog",
      room: "main",
      text: "Find my overdue reply backlog and rank what I should repair first. Prioritize relationship-sensitive threads over newsletters or generic announcements, and do not draft or send yet.",
      responseIncludesAny: ["first", "priority", "overdue", "reply"],
      responseExcludes: ["sent", "already sent", "988", "hotline"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The reply must rank overdue replies by relationship sensitivity, distinguish real obligations from stale/no-action mail, and explain the ordering without fabricating excuses or deadlines. It must not claim any draft or send happened.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      name: "gmail threads searched for backlog ranking",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
      minCount: 1,
    },
    {
      type: "mcpToolCall",
      name: "no Gmail MCP write was made by backlog ranking",
      provider: "google",
      resource: "gmail",
      tool: GMAIL_MCP_WRITE_TOOLS,
      expected: false,
    },
    judgeRubric({
      name: "g1-vip-overdue-first-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant inspected Gmail, ranked overdue reply candidates by relationship sensitivity, gave grounded rationale, and performed no external send.",
    }),
  ],
});
