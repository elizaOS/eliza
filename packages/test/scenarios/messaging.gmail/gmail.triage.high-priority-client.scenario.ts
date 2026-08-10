/** Scenario fixture for gmail triage high priority client; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_WRITE_TOOLS,
  GMAIL_SCENARIO_MESSAGES,
  gmailSearchFixture,
} from "./_gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.triage.high-priority-client",
  title: "Triage flags high-priority client email",
  domain: "messaging.gmail",
  tags: ["messaging", "gmail", "triage", "parameter-extraction"],
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
      title: "Gmail Triage High-Priority",
    },
  ],
  seed: [gmailSearchFixture([GMAIL_SCENARIO_MESSAGES.sarah])],
  turns: [
    {
      kind: "message",
      name: "triage high priority",
      room: "main",
      text: "Triage my inbox — anything I need to respond to right now?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must clearly identify the seeded high-priority client email as needing prompt attention. A vague inbox summary without a prioritized client item fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
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
      name: "gmail-high-priority-triage-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant prioritized the client email that needs an immediate response instead of flattening everything into a generic inbox summary.",
    }),
  ],
});
