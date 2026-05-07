import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.inbox.daily-brief-includes-unsent-drafts",
  title: "Morning brief includes pending drafts still waiting for sign-off",
  domain: "executive-assistant",
  tags: ["executive-assistant", "briefing", "drafts", "transcript-derived"],
  description:
    "Transcript-derived case: pending drafts in the approval queue appear in the morning brief with enough context for the owner to approve or revise them.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Daily Brief Includes Unsent Drafts",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-daily-brief-with-drafts",
      room: "main",
      text: "In the morning brief, add a Pending Drafts section that lists which drafts still need my sign-off and who they are for.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CHECKIN", "TRIAGE_MESSAGES", "TRIAGE_MESSAGES"],
        description: "morning brief approval queue review",
        includesAny: [
          "draft",
          "sign-off",
          "approval",
          "brief",
          "pending drafts",
        ],
      }),
      responseIncludesAny: [
        "Pending Drafts",
        "draft",
        "sign-off",
        "approval",
        "brief",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface the actual approval-queue contents in a Pending Drafts section, including the draft count and enough per-draft context to identify the recipient or topic. A vague 'check your drafts' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CHECKIN", "TRIAGE_MESSAGES", "TRIAGE_MESSAGES"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["TRIAGE_MESSAGES", "TRIAGE_MESSAGES"],
      includesAny: ["draft", "sign-off", "approval", "pending"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      state: "pending",
    },
    {
      type: "draftExists",
      expected: true,
    },
    {
      type: "custom",
      name: "ea-daily-brief-drafts-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CHECKIN", "TRIAGE_MESSAGES", "TRIAGE_MESSAGES"],
        description: "morning brief approval queue review",
        includesAny: ["draft", "sign-off", "approval", "brief", "pending"],
      }),
    },
    {
      type: "custom",
      name: "ea-daily-brief-drafts-pending-approvals",
      predicate: expectApprovalRequest({
        description:
          "brief reflects pending approval entries from the queue, not stale text",
        state: "pending",
      }),
    },
    judgeRubric({
      name: "ea-daily-brief-drafts-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the morning brief lists the actual pending drafts in the approval queue with enough context (recipient/topic) for the owner to decide whether to send them.",
    }),
  ],
});
