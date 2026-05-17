import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.stuck-agent-falls-back-to-SMS",
  title: "When the voice call to the stuck-agent user fails, fall back to SMS",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "fallback", "escalation"],
  description:
    "Voice call to the user went to voicemail. The agent must fall back to SMS — not give up, not silently retry voice.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Stuck fallback SMS",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "voice-call-attempt",
        outcome: "voicemail",
        attemptedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        reason: "CAPTCHA on United check-in",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "voice-failed-fallback",
      room: "main",
      text: "The call hit my voicemail. What's the next step?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "VOICE_CALL"],
        description: "voicemail → SMS fallback",
        includesAny: ["SMS", "text", "voicemail", "fallback"],
      }),
      responseIncludesAny: ["SMS", "text", "voicemail"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to sending an SMS fallback. Silently retrying voice, or giving up, both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "VOICE_CALL"],
    },
    {
      type: "pushSent",
      channel: ["sms"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: "sms",
    },
    {
      type: "custom",
      name: "push-sms-fallback-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "VOICE_CALL"],
        description: "SMS fallback after voicemail",
      }),
    },
    {
      type: "custom",
      name: "push-sms-fallback-dispatch",
      predicate: expectConnectorDispatch({
        channel: "sms",
        description: "SMS dispatched as fallback channel",
      }),
    },
    judgeRubric({
      name: "push-sms-fallback-rubric",
      threshold: 0.7,
      description:
        "After voicemail outcome, agent fell back to SMS — not retry voice or abandon.",
    }),
  ],
});
