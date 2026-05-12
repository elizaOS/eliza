import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.draft.followup-14-days",
  title: "Identify 14-day-old email without a reply for follow-up",
  domain: "messaging.gmail",
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
      actionName: ["MESSAGE", "MESSAGE", "RELATIONSHIP"],
      subaction: "unresponded",
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "draft_reply",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/threads",
      minCount: 1,
    },
    {
      type: "gmailDraftCreated",
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
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
