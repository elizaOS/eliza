import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectStateTransition,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.push.multi-device-meeting-ladder",
  title: "Send a multi-device reminder ladder before important meetings",
  domain: "executive-assistant",
  tags: ["executive-assistant", "push", "reminders", "transcript-derived"],
  description:
    "Transcript-derived case: remind on desktop and phone at one hour, ten minutes, and start time, and stop the ladder once the user acknowledges on either device.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Multi-Device Meeting Ladder",
    },
    {
      id: "mac",
      source: "discord",
      channelType: "DM",
      title: "EA Multi-Device Meeting Ladder Mac Ack",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-reminder-ladder",
      room: "main",
      text: "For important meetings, remind me an hour before, ten minutes before, and right when they start on both my Mac and my phone.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "multi-device meeting reminder ladder",
        includesAny: ["hour", "ten minutes", "mac", "phone", "meeting"],
      }),
      responseIncludesAny: ["hour", "ten minutes", "Mac", "phone", "meeting"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to a three-step ladder (1h → 10m → start) on both Mac and phone, and indicate that acknowledging on one device suppresses the rest. A vague 'I'll remind you' fails.",
      },
    },
    {
      kind: "message",
      name: "acknowledge-first-rung-on-mac",
      room: "mac",
      text: "I saw the first reminder on my Mac. Clear the remaining phone reminders too.",
      responseIncludesAny: ["Mac", "phone", "clear", "acknowledged"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must treat the Mac acknowledgement as suppressing the remaining ladder on both devices. A reply that only says 'okay' without confirming suppression fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "CALENDAR"],
    },
    {
      type: "pushSent",
      channel: ["desktop", "mobile"],
    },
    {
      type: "pushEscalationOrder",
      channelOrder: ["desktop", "mobile"],
    },
    {
      type: "pushAcknowledgedSync",
      expected: true,
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["desktop", "mobile"],
      actionName: ["DEVICE_INTENT"],
      minCount: 2,
    },
    {
      type: "custom",
      name: "ea-meeting-ladder-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "multi-device meeting reminder ladder",
        includesAny: ["hour", "ten minutes", "mac", "phone", "meeting"],
      }),
    },
    {
      type: "custom",
      name: "ea-meeting-ladder-multi-device-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        description:
          "ladder fires on both desktop and mobile in the expected order",
        minCount: 2,
      }),
    },
    {
      type: "custom",
      name: "ea-meeting-ladder-ack-suppression",
      predicate: expectStateTransition({
        subject: "deviceIntent",
        to: "acknowledged",
        description:
          "device intent transitions to acknowledged so the remaining ladder rungs are suppressed",
      }),
    },
    judgeRubric({
      name: "ea-meeting-ladder-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant fired three reminders on both desktop and mobile in order (1h, 10m, start) and stopped sending after acknowledgement on either device.",
    }),
  ],
});
