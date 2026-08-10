/** Scenario fixture for gmail bulk archive newsletters; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { gmailScenario } from "./_factory.ts";
import {
  GMAIL_SCENARIO_MESSAGES,
  gmailMcpFixture,
  gmailSearchFixture,
  gmailThreadFixture,
} from "./_gmail-mcp-fixtures.ts";

export default gmailScenario({
  id: "gmail.bulk.archive-newsletters",
  title: "Bulk archive selected Gmail newsletter",
  tags: ["messaging", "gmail", "bulk", "archive", "inbox-zero"],
  roomTitle: "Gmail Archive Newsletter",
  seed: [
    gmailSearchFixture([GMAIL_SCENARIO_MESSAGES.newsletter], { repeat: true }),
    gmailThreadFixture([GMAIL_SCENARIO_MESSAGES.newsletter]),
    gmailMcpFixture({
      tool: "unlabel_thread",
      arguments: { threadId: "thr-news", labelIds: ["INBOX"] },
      structuredContent: {
        threadId: "thr-news",
        removedLabelIds: ["INBOX"],
      },
    }),
  ],
  turns: [
    {
      name: "locate newsletter",
      text: "Find the Weekly Digest newsletter in Gmail and verify it is the automated digest, not a person or invoice.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must locate the Weekly Digest newsletter and distinguish it from person-to-person mail or invoice mail.",
      },
    },
    {
      name: "archive newsletter",
      text: "Archive that newsletter now, and only that newsletter.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must bind the archive operation to the newsletter selected in the previous step. It must not archive person-to-person messages, finance mail, spam, or unrelated inbox items.",
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
      operation: "archive",
    },
    {
      type: "mcpToolCalls",
      provider: "google",
      resource: "gmail",
      calls: [
        { tool: "search_threads" },
        {
          tool: "unlabel_thread",
          arguments: { threadId: "thr-news", labelIds: ["INBOX"] },
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
      name: "gmail-archive-newsletter-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant resolved the newsletter target first and then archived only that Gmail thread through the official unlabel_thread tool.",
    }),
  ],
});
