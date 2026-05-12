import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.voice-call-as-last-resort",
  title: "Voice call fires only after the SMS rung has been unacknowledged for 10m",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "ladder", "voice", "last-resort"],
  description:
    "Escalation order: desktop → mobile → SMS → voice. Voice should fire only when the SMS rung went 10m+ unacknowledged. Catches over-eager voice escalation.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Voice last resort",
    },
  ],
  seed: [
    {
      type: "advanceClock",
      by: "12m",
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "ladder-state",
        history: [
          { channel: "desktop", at: new Date(Date.now() - 30 * 60_000).toISOString(), ackedAt: null },
          { channel: "mobile", at: new Date(Date.now() - 22 * 60_000).toISOString(), ackedAt: null },
          { channel: "sms", at: new Date(Date.now() - 12 * 60_000).toISOString(), ackedAt: null },
        ],
        urgency: "critical",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "voice-last-resort",
      room: "main",
      text: "Critical SMS has been ignored 12 minutes after desktop and mobile also failed. What's next?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "voice last-resort escalation",
        includesAny: ["call", "voice", "last resort", "critical"],
      }),
      responseIncludesAny: ["call", "voice", "critical"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must escalate to voice call NOW, not retry desktop/SMS. Voice-only-after-SMS-≥10m is the contract.",
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
      type: "pushEscalationOrder",
      channelOrder: ["desktop", "mobile", "sms", "phone_call"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: "phone_call",
      actionName: ["VOICE_CALL"],
    },
    {
      type: "custom",
      name: "push-voice-last-resort-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "voice last resort",
      }),
    },
    {
      type: "custom",
      name: "push-voice-last-resort-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description: "voice fired only after SMS exhausted",
      }),
    },
    judgeRubric({
      name: "push-voice-last-resort-rubric",
      threshold: 0.7,
      description:
        "Voice escalation fired AFTER SMS was unacked 12m — last resort order respected.",
    }),
  ],
});
