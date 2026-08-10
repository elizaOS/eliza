/** Scenario fixture for gmail triage unread; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_WRITE_TOOLS,
  GMAIL_SCENARIO_MESSAGES,
  gmailSearchFixture,
} from "./_gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.triage.unread",
  title: "Triage unread Gmail inbox",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "triage", "happy-path", "smoke"],
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
      title: "Gmail Triage Unread",
    },
  ],
  seed: [
    gmailSearchFixture([
      GMAIL_SCENARIO_MESSAGES.finance,
      GMAIL_SCENARIO_MESSAGES.sarah,
      GMAIL_SCENARIO_MESSAGES.newsletter,
    ]),
  ],
  turns: [
    {
      kind: "message",
      name: "triage unread",
      room: "main",
      text: "Triage my unread email",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must summarize unread Gmail and distinguish messages that need the owner's attention from lower-value inbox items. It must not claim it modified or sent anything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: "MESSAGE",
      subaction: "triage",
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
      name: "gmail-unread-triage-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant used Gmail triage to summarize unread mail without modifying or sending Gmail messages.",
    }),
  ],
});
