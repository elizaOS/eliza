/** Scenario fixture for gmail draft followup 14 days; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { gmailScenario } from "./_factory.ts";
import {
  GMAIL_SCENARIO_MESSAGES,
  gmailCreateDraftFixture,
  gmailSearchFixture,
  gmailThreadFixture,
} from "./_gmail-mcp-fixtures.ts";

export default gmailScenario({
  id: "gmail.draft.followup-14-days",
  title: "Identify 14-day-old email without a reply for follow-up",
  tags: ["messaging", "gmail", "followup", "parameter-extraction"],
  roomTitle: "Gmail Follow-up Tracker",
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
    gmailCreateDraftFixture({
      threadId: "thr-unresponded",
      draftId: "draft-followup",
    }),
  ],
  turns: [
    {
      name: "find followups",
      text: "Who haven't I followed up with?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface at least one overdue follow-up from email and make clear why it is overdue, such as no reply in roughly two weeks. A generic inbox summary without a follow-up recommendation fails.",
      },
    },
    {
      name: "draft followup",
      text: "Draft a short follow-up to that selected stale Gmail thread, but do not send it.",
      responseJudge: {
        minimumScore: 0.72,
        rubric:
          "The assistant must use the stale thread selected in the previous step, create only a draft follow-up, and explicitly keep the message unsent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE", "RELATIONSHIP"],
      subaction: "unresponded",
    },
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
          arguments: { to: ["vendor@example.com"] },
        },
      ],
    },
    judgeRubric({
      name: "gmail-followup-tracker-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant identified the stale email follow-up, selected that thread, and produced an unsent Gmail draft instead of a generic summary or silent send.",
    }),
  ],
});
