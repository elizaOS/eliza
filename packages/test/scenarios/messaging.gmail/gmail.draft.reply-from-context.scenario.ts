/** Scenario fixture for gmail draft reply from context; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { gmailScenario } from "./_factory.ts";
import {
  GMAIL_SCENARIO_MESSAGES,
  gmailCreateDraftFixture,
  gmailSearchFixture,
  gmailThreadFixture,
} from "./_gmail-mcp-fixtures.ts";

export default gmailScenario({
  id: "gmail.draft.reply-from-context",
  title: "Draft Gmail reply using recent email context",
  tags: ["messaging", "gmail", "draft", "happy-path"],
  roomTitle: "Gmail Draft Reply",
  seed: [
    gmailSearchFixture([GMAIL_SCENARIO_MESSAGES.sarah], { repeat: true }),
    gmailThreadFixture([GMAIL_SCENARIO_MESSAGES.sarah]),
    gmailCreateDraftFixture({
      threadId: "thr-sarah",
      draftId: "draft-sarah-friday",
    }),
  ],
  turns: [
    {
      name: "draft reply to sarah",
      text: "Draft a reply to Sarah's latest email saying I can review it Friday afternoon, but don't send it yet.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must present a draft email to Sarah that includes the Friday-afternoon availability and must not claim it was already sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "draft_reply",
    },
    {
      type: "mcpToolCalls",
      provider: "google",
      resource: "gmail",
      calls: [
        { tool: "search_threads" },
        {
          tool: "create_draft",
          arguments: {
            to: ["sarah@example.com"],
            replyToMessageId: "msg-sarah",
          },
        },
      ],
    },
    judgeRubric({
      name: "gmail-draft-reply-from-context-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the Gmail reply from recent context and kept it as a draft instead of claiming it was sent.",
    }),
  ],
});
