/** Scenario fixture for gmail recommend inbox zero plan; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_WRITE_TOOLS,
  GMAIL_SCENARIO_MESSAGES,
  gmailSearchFixture,
} from "./_gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.recommend.inbox-zero-plan",
  title: "Recommend Gmail inbox-zero actions without writing",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "recommendations", "inbox-zero", "read-only"],
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
      title: "Gmail Inbox-Zero Recommendations",
    },
  ],
  seed: [
    gmailSearchFixture([
      GMAIL_SCENARIO_MESSAGES.finance,
      GMAIL_SCENARIO_MESSAGES.sarah,
      GMAIL_SCENARIO_MESSAGES.julia,
      GMAIL_SCENARIO_MESSAGES.newsletter,
      GMAIL_SCENARIO_MESSAGES.spam,
    ]),
  ],
  turns: [
    {
      kind: "message",
      name: "recommend inbox-zero actions",
      room: "main",
      text: "Review my Gmail inbox and recommend what I should reply to, archive, mark read, or flag as spam. Do not change anything yet.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must produce a Gmail cleanup recommendation plan with separate reply, archive/mark-read, and spam-review categories. It must not claim it modified, archived, marked, reported, drafted, or sent anything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "recommend",
    },
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
      name: "gmail-inbox-zero-recommendation-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant used Gmail recommendations as a read-only planning step and kept all write operations out of the run.",
    }),
  ],
});
