import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectApprovalStateTransition,
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.followup.repair-missed-call-and-reschedule",
  title: "Repair a missed call and reschedule it quickly",
  domain: "executive-assistant",
  tags: ["executive-assistant", "followup", "calendar", "transcript-derived"],
  description:
    "Transcript-derived case: the user missed a call, the assistant drafts a repair note behind approval, the user approves the send, and the follow-up is explicitly closed once the reschedule lands.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Repair Missed Call",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "repair-missed-call",
      room: "main",
      text: "I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap, but hold the note for my approval first.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE", "CALENDAR", "MESSAGE"],
        description: "missed-call repair draft",
        includesAny: [
          "repair",
          "reschedule",
          "call",
          "Frontier Tower",
          "approval",
        ],
      }),
      responseIncludesAny: [
        "repair",
        "reschedule",
        "apology",
        "approval",
        "draft",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must draft an apology-style repair note to Frontier Tower, propose a concrete reschedule path, and make clear that the outbound send is being held for approval. A vague 'I'll look into it' fails.",
      },
    },
    {
      kind: "message",
      name: "approve-repair-note",
      room: "main",
      text: "Yes, approve that repair note and send it now.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "RESOLVE_REQUEST", "MESSAGE", "MESSAGE"],
        description: "repair approval and dispatch",
        includesAny: ["approve", "send", "repair", "Frontier Tower"],
      }),
      responseIncludesAny: ["approved", "sent", "repair", "Frontier Tower"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "After approval, the reply must acknowledge the approval and confirm the repair message was sent or is actively being delivered. A second draft preview or a fresh request for confirmation fails.",
      },
    },
    {
      kind: "message",
      name: "close-loop-after-reschedule",
      room: "main",
      text: "They confirmed Thursday at 2pm works. Mark the Frontier Tower follow-up done and close the loop.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "CALENDAR", "MESSAGE"],
        description: "follow-up loop closure",
        includesAny: [
          "Frontier Tower",
          "follow-up",
          "done",
          "Thursday",
          "close",
        ],
      }),
      responseIncludesAny: ["Frontier Tower", "follow", "done", "Thursday"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The final reply must acknowledge the Thursday reschedule outcome and explicitly close the follow-up loop, not leave the relationship task hanging open.",
      },
    },
  ],
  finalChecks: [
    {
      type: "draftExists",
      channel: ["gmail", "telegram", "discord", "signal"],
      expected: true,
    },
    {
      type: "selectedAction",
      actionName: [
        "MESSAGE",
        "RELATIONSHIP",
        "RESOLVE_REQUEST",
        "MESSAGE",
        "CALENDAR",
        "MESSAGE",
      ],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      state: ["approved", "executing", "done"],
      actionName: ["MESSAGE", "MESSAGE", "MESSAGE"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["gmail", "telegram", "discord", "signal"],
      actionName: ["MESSAGE", "MESSAGE", "MESSAGE"],
    },
    {
      type: "custom",
      name: "ea-repair-missed-call-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "MESSAGE",
          "RELATIONSHIP",
          "RESOLVE_REQUEST",
          "MESSAGE",
          "CALENDAR",
          "MESSAGE",
        ],
        description: "missed-call repair lifecycle",
        includesAny: [
          "repair",
          "reschedule",
          "call",
          "Frontier Tower",
          "follow-up",
        ],
        minCount: 3,
      }),
    },
    {
      type: "custom",
      name: "ea-repair-missed-call-approval",
      predicate: expectApprovalRequest({
        description:
          "repair note is queued behind approval before the outbound send happens",
        actionName: ["MESSAGE", "MESSAGE", "MESSAGE"],
      }),
    },
    {
      type: "custom",
      name: "ea-repair-missed-call-approval-transition",
      predicate: expectApprovalStateTransition({
        description: "repair approval moved pending → approved before dispatch",
        from: "pending",
        to: "approved",
        actionName: ["MESSAGE", "MESSAGE", "MESSAGE"],
      }),
    },
    {
      type: "custom",
      name: "ea-repair-missed-call-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["gmail", "telegram", "discord", "signal"],
        description: "repair note reaches the counterparty on a real channel",
      }),
    },
    judgeRubric({
      name: "ea-repair-missed-call-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the apology, held it for approval, dispatched it after explicit approval, and then marked the Frontier Tower follow-up closed once the reschedule was confirmed.",
    }),
  ],
});
