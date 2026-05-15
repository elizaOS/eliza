import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.escalate-to-voice-call",
  title: "Escalate a stalled follow-up to a voice call via Twilio",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "escalation", "twilio", "voice"],
  description:
    "After SMS + email + chat all went unanswered for 72h on a time-sensitive matter, the user authorizes a voice-call escalation. The agent must dispatch via the twilio voice mock — not silently keep texting.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Escalate to voice call",
    },
  ],
  seed: [
    {
      type: "advanceClock",
      by: "72h",
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "stalled-thread",
        counterparty: "vendor-billing",
        topic: "approve invoice #4421 before EOD",
        channelsTried: ["email", "sms", "chat"],
        urgency: "time-sensitive",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "escalate-voice",
      room: "main",
      text: "Vendor billing hasn't replied on the invoice for 3 days across email + SMS + chat. Call them on the registered line and explain.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "voice escalation after silence",
        includesAny: ["call", "vendor", "voice", "invoice"],
      }),
      responseIncludesAny: ["call", "vendor", "voice", "invoice"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to placing a phone call (not another SMS) and reference the invoice. A reply that says 'I'll text them again' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["VOICE_CALL"],
    },
    {
      type: "pushSent",
      channel: "phone_call",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "phone_call",
      actionName: ["VOICE_CALL"],
    },
    {
      type: "custom",
      name: "followup-voice-escalate-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "voice escalation",
      }),
    },
    {
      type: "custom",
      name: "followup-voice-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description: "twilio voice dispatched",
      }),
    },
    judgeRubric({
      name: "followup-escalate-voice-rubric",
      threshold: 0.7,
      description:
        "Voice call dispatched via twilio after non-voice channels were exhausted.",
    }),
  ],
});
