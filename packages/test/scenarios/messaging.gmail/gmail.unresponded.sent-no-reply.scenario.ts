/** Scenario fixture for gmail unresponded sent no reply; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { gmailScenario } from "./_factory.ts";
import {
  GMAIL_MCP_WRITE_TOOLS,
  GMAIL_SCENARIO_MESSAGES,
  gmailSearchFixture,
  gmailThreadFixture,
} from "./_gmail-mcp-fixtures.ts";

export default gmailScenario({
  id: "gmail.unresponded.sent-no-reply",
  title: "Find sent Gmail threads with no later human reply",
  tags: ["messaging", "gmail", "unresponded", "followup", "read-only"],
  roomTitle: "Gmail Unresponded Threads",
  seed: [
    gmailSearchFixture(
      [
        GMAIL_SCENARIO_MESSAGES.unrespondedInbound,
        GMAIL_SCENARIO_MESSAGES.unrespondedSent,
      ],
      { repeat: true },
    ),
    gmailThreadFixture([
      GMAIL_SCENARIO_MESSAGES.unrespondedInbound,
      GMAIL_SCENARIO_MESSAGES.unrespondedSent,
    ]),
  ],
  turns: [
    {
      name: "find unresponded sent threads",
      text: "Who have I emailed from Gmail and not heard back from in the last two weeks? Do not draft or send anything yet.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must identify the stale Gmail thread where the owner sent a follow-up and no later human reply arrived. It must not draft, send, archive, delete, or report anything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "unresponded",
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
      name: "gmail-unresponded-thread-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant used thread chronology to find a true unresponded Gmail thread and did not turn the read-only check into a draft or send.",
    }),
  ],
});
