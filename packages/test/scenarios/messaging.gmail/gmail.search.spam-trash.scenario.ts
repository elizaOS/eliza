/** Scenario fixture for gmail search spam trash; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { gmailScenario } from "./_factory.ts";
import {
  GMAIL_MCP_WRITE_TOOLS,
  GMAIL_SCENARIO_MESSAGES,
  gmailSearchFixture,
  gmailThreadFixture,
} from "./_gmail-mcp-fixtures.ts";

export default gmailScenario({
  id: "gmail.search.spam-trash",
  title: "Search Gmail spam and trash without modifying messages",
  tags: ["messaging", "gmail", "search", "spam", "read-only"],
  roomTitle: "Gmail Spam Search",
  seed: [
    gmailSearchFixture([GMAIL_SCENARIO_MESSAGES.spam], { repeat: true }),
    gmailThreadFixture([GMAIL_SCENARIO_MESSAGES.spam]),
  ],
  turns: [
    {
      name: "read spam notice",
      text: "Look in Gmail spam or trash for the suspicious account notice and read it. Do not report it, delete it, archive it, or mark it read.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must search or read Gmail spam/trash content, identify the synthetic account notice, and keep the run read-only. Any claim that it reported, deleted, archived, marked read, replied, or sent fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: ["search", "read"],
    },
    {
      type: "mcpToolCalls",
      provider: "google",
      resource: "gmail",
      calls: [{ tool: "search_threads" }, { tool: "get_thread" }],
    },
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: GMAIL_MCP_WRITE_TOOLS,
      expected: false,
    },
    judgeRubric({
      name: "gmail-spam-search-readonly-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant looked in Gmail spam/trash and read the matching message without performing any Gmail write.",
    }),
  ],
});
