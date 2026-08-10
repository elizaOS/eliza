/** Scenario fixture for gmail bulk apply label name resolution; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { gmailScenario } from "./_factory.ts";
import {
  GMAIL_SCENARIO_MESSAGES,
  gmailMcpFixture,
  gmailSearchFixture,
} from "./_gmail-mcp-fixtures.ts";

export default gmailScenario({
  id: "gmail.bulk.apply-label.name-resolution",
  title: "Resolve Gmail label name before applying it",
  tags: ["messaging", "gmail", "bulk", "label", "inbox-zero"],
  roomTitle: "Gmail Label Name Resolution",
  seed: [
    gmailSearchFixture([GMAIL_SCENARIO_MESSAGES.finance], { repeat: true }),
    gmailMcpFixture({
      tool: "list_labels",
      structuredContent: {
        labels: [{ id: "Label_1", name: "eliza-e2e", type: "user" }],
      },
      repeat: true,
    }),
    gmailMcpFixture({
      tool: "label_message",
      arguments: { messageId: "msg-finance", labelIds: ["Label_1"] },
      structuredContent: {
        messageId: "msg-finance",
        appliedLabelIds: ["Label_1"],
      },
    }),
  ],
  turns: [
    {
      name: "select finance message",
      text: "Find the Gmail invoice message that needs filing under the existing label named eliza-e2e. Do not change anything yet.",
      responseJudge: {
        minimumScore: 0.72,
        rubric:
          "The assistant must identify the finance/invoice Gmail message as the target and keep this step read-only.",
      },
    },
    {
      name: "apply resolved label",
      text: "Apply the existing Gmail label named eliza-e2e to that selected finance message only. I confirm this Gmail label change.",
      responseJudge: {
        minimumScore: 0.78,
        rubric:
          "The assistant must resolve the human label name through Gmail labels, apply only the resolved label to the previously selected finance message, and not silently create or guess a different label.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: ["search", "read"],
      minCount: 1,
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "manage",
      operation: "apply_label",
      fields: {
        labelIds: "Label_1",
      },
    },
    {
      type: "mcpToolCalls",
      provider: "google",
      resource: "gmail",
      calls: [
        { tool: "search_threads" },
        { tool: "list_labels" },
        {
          tool: "label_message",
          arguments: {
            messageId: "msg-finance",
            labelIds: ["Label_1"],
          },
        },
      ],
    },
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "create_draft",
      expected: false,
    },
    judgeRubric({
      name: "gmail-label-name-resolution-rubric",
      threshold: 0.78,
      description:
        "End-to-end: the assistant selected the finance message first, resolved the existing Gmail label name to its Gmail label ID, and applied that label without drafting, sending, or guessing.",
    }),
  ],
});
