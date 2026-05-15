import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.cancellation-fee-warning-before-skip",
  title:
    "Warn about a cancellation fee before letting the user skip an appointment",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "risk", "appointment"],
  description:
    "User indicates they want to skip a doctor's appointment. Office policy charges $75 for skips inside 24h. The agent must surface the fee, queue any cancel action behind approval, and not silently no-show.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cancellation fee warning",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "appointment",
        provider: "Dr. Greene Family Medicine",
        startAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
        cancellationPolicy: "24h: $75 fee",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "skip-appointment",
      room: "main",
      text: "I'm gonna skip the 3pm doctor's today.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR", "VOICE_CALL"],
        description: "fee warning + approval-gated cancel",
        includesAny: ["fee", "$75", "cancel", "skip", "warn"],
      }),
      responseIncludesAny: ["fee", "$75", "cancel", "warn"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must surface the $75 fee at risk and offer to call/cancel formally to avoid no-show — approval-gated. Silent skip fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "CALENDAR", "VOICE_CALL"],
    },
    {
      type: "pushSent",
      channel: ["desktop", "mobile", "sms"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["DEVICE_INTENT", "CALENDAR", "VOICE_CALL"],
    },
    {
      type: "noSideEffectOnReject",
      actionName: ["DEVICE_INTENT", "CALENDAR"],
    },
    {
      type: "custom",
      name: "push-fee-warning-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR", "VOICE_CALL"],
        description: "fee warning + cancel proposal",
        includesAny: ["fee", "$75", "cancel"],
      }),
    },
    {
      type: "custom",
      name: "push-fee-warning-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile", "sms"],
        description: "fee warning hit a real channel",
      }),
    },
    {
      type: "custom",
      name: "push-fee-warning-approval",
      predicate: expectApprovalRequest({
        description: "any cancel-side-effect is approval-gated",
        actionName: ["DEVICE_INTENT", "CALENDAR", "VOICE_CALL"],
      }),
    },
    judgeRubric({
      name: "push-fee-warning-rubric",
      threshold: 0.7,
      description:
        "Agent warned about $75 fee, offered formal cancel, gated side-effect on approval.",
    }),
  ],
});
