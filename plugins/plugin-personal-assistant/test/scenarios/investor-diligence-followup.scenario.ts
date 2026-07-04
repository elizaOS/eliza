/**
 * Live-model scenario (live-only lane): Diligence follow-up is scheduled with real arguments and the legal hold gate holds.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "investor-diligence-followup",
  title:
    "Diligence follow-up is scheduled with real arguments and the legal hold gate holds",
  domain: "executive.followup",
  tags: [
    "lifeops",
    "executive-assistant",
    "followup",
    "documents",
    "privacy",
    "outcome",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Investor Diligence Follow-Up",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-diligence-asks",
      room: "main",
      text: "Track investor diligence follow-ups: unanswered data requests, owner for each doc, redacted materials, promised timing, and open legal caveats.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must set up a concrete diligence tracker: each unanswered data request mapped to a document owner, promised timing, and its legal caveat, framed as items being tracked (not a one-off summary that is immediately forgotten).",
      },
    },
    {
      kind: "message",
      name: "draft-investor-followup",
      room: "main",
      text: "Draft a follow-up note and escalation tracker, but hold anything containing redacted materials until legal approves.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseExcludes: ["already sent", "i've sent", "i have sent", "sent it"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must present the follow-up draft and escalation tracker while stating explicitly that anything touching redacted materials is held for legal approval. Claiming the note was sent, or ignoring the legal hold, fails.",
      },
    },
  ],
  finalChecks: [
    // OUTCOME: the diligence follow-up work became a captured scheduled item
    // whose arguments actually carry the diligence tracking.
    {
      type: "selectedActionArguments",
      name: "diligence-tracker-scheduled-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "WORK_THREAD",
        "LIFE",
      ],
      includesAny: ["diligence", "investor", "data request"],
    },
    // NEGATIVE OUTCOME: the legal hold gate held — no delivered external send.
    {
      type: "custom",
      name: "diligence-legal-hold-gate-held",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "investor-diligence-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant built a tracked diligence follow-up (real scheduled item, owners and timing per document), drafted the investor note, and held everything containing redacted materials behind legal approval with no external dispatch.",
    },
  ],
});
