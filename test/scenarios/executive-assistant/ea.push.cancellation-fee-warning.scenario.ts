import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.push.cancellation-fee-warning",
  title: "Warn the user when missing something may incur a fee",
  domain: "executive-assistant",
  tags: ["executive-assistant", "push", "risk", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant warns the user that a late cancellation may cost money and offers to act immediately. Action requires approval before any side-effect (e.g., contacting the venue).",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Cancellation Fee Warning",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cancellation-fee-warning",
      room: "main",
      text: "If missing this could trigger a cancellation fee, warn me clearly and offer to handle it now.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "DEVICE_INTENT",
          "VOICE_CALL",
          "CALENDAR",
        ],
        description: "financial-risk escalation",
        includesAny: ["fee", "cancellation", "warn", "handle"],
      }),
      responseIncludesAny: ["fee", "warn", "handle", "now", "cancellation"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must clearly warn that a cancellation fee is at risk, offer to act now, and queue the action behind explicit approval. Hidden auto-execution or a non-actionable warning both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "VOICE_CALL", "CALENDAR"],
    },
    {
      type: "pushSent",
      channel: ["desktop", "mobile", "sms"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["DEVICE_INTENT", "CALENDAR"],
    },
    {
      type: "noSideEffectOnReject",
      actionName: ["DEVICE_INTENT", "CALENDAR"],
    },
    {
      type: "custom",
      name: "ea-cancellation-fee-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "DEVICE_INTENT",
          "VOICE_CALL",
          "CALENDAR",
        ],
        description: "financial-risk escalation",
        includesAny: ["fee", "cancellation", "warn", "handle"],
      }),
    },
    {
      type: "custom",
      name: "ea-cancellation-fee-warning-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile", "sms"],
        description: "warning landed on at least one user device or sms",
      }),
    },
    {
      type: "custom",
      name: "ea-cancellation-fee-approval-required",
      predicate: expectApprovalRequest({
        description:
          "the offered fix is gated on approval rather than executed silently",
        actionName: ["DEVICE_INTENT", "CALENDAR"],
      }),
    },
    judgeRubric({
      name: "ea-cancellation-fee-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant warned the user about the fee on a real device channel and queued the remediation behind explicit approval — no autonomous execution, no silent skip.",
    }),
  ],
});
