import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.signature-deadline-SMS-4h-before-appointment",
  title: "SMS the user 4h before an appointment if a required signature is still pending",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "sms", "deadline", "signature"],
  description:
    "Tomorrow's appointment requires a signed consent. If unsigned, the agent must fire an SMS 4h before — not a desktop notification that might be missed when the user is mobile. SMS specifically.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Signature deadline SMS",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "appointment",
        provider: "Westside Imaging",
        startAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
        requiresSignature: true,
        signatureCompleted: false,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule-sms-deadline",
      room: "main",
      text: "If the consent for Westside Imaging isn't signed 4 hours before the appointment, SMS me — don't use desktop, I'll be out.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "4h SMS deadline reminder",
        includesAny: ["4 hours", "SMS", "consent", "signature", "Westside"],
      }),
      responseIncludesAny: ["4 hours", "SMS", "consent", "signature"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to an SMS specifically (not desktop) at T-4h if the signature is still pending. Choosing desktop fails — user said they'd be out.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "pushSent",
      channel: "sms",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "sms",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "custom",
      name: "push-signature-sms-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "SMS-specific deadline reminder",
      }),
    },
    {
      type: "custom",
      name: "push-signature-sms-dispatch",
      predicate: expectConnectorDispatch({
        channel: "sms",
        actionName: ["DEVICE_INTENT"],
        description: "SMS dispatched (not desktop)",
      }),
    },
    judgeRubric({
      name: "push-signature-sms-rubric",
      threshold: 0.7,
      description:
        "4h-before SMS scheduled tied to the pending signature.",
    }),
  ],
});
