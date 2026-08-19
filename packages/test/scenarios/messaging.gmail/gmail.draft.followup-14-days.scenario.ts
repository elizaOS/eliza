/** Scenario fixture for gmail draft followup 14 days; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  gmailExactDraftBinding,
  gmailNoWriteOnTurns,
} from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.draft.followup-14-days",
  title: "Identify 14-day-old email without a reply for follow-up",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "followup", "parameter-extraction"],
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
      title: "Gmail Follow-up Tracker",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "followup-14-days-ago.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "find followups",
      room: "main",
      text: "Who haven't I followed up with?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface at least one overdue follow-up from email and make clear why it is overdue, such as no reply in roughly two weeks. A generic inbox summary without a follow-up recommendation fails.",
      },
    },
    {
      kind: "message",
      name: "draft followup",
      room: "main",
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
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX", "RELATIONSHIP"],
      subaction: "unresponded",
      turn: "find followups",
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: "draft_reply",
      turn: "draft followup",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/threads",
      minCount: 1,
      turn: "find followups",
    },
    {
      type: "gmailDraftCreated",
      turn: "draft followup",
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    gmailNoWriteOnTurns("follow-up discovery is read-only", "find followups"),
    gmailExactDraftBinding({
      name: "follow-up draft binds to stale outbound message",
      turn: "draft followup",
      sourceMessageId: "msg-unresponded-sent",
      bodyIncludesAll: ["follow"],
    }),
    judgeRubric({
      name: "gmail-followup-tracker-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant identified the stale email follow-up, selected that thread, and produced an unsent Gmail draft instead of a generic summary or silent send.",
    }),
  ],
  cleanup: [
    {
      type: "gmailDeleteDrafts",
      account: "test-owner",
      tag: "eliza-e2e",
    },
  ],
});
