import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectStateTransition,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.full-ladder-T-1h-10m-0",
  title: "Complete reminder ladder T-1h → T-10m → T-0 across devices",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "ladder", "end-to-end"],
  description:
    "End-to-end ladder: agent schedules three DEVICE_INTENT rungs at T-1h, T-10m, and T-0 on desktop + mobile. Acknowledgement at any rung must suppress the rest.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Full ladder",
    },
    {
      id: "phone",
      source: "discord",
      channelType: "DM",
      title: "Mobile ack channel",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-full-ladder",
      room: "main",
      text: "For every important meeting today: full ladder 1h, 10m, and at-start on Mac and phone. Acking once silences the rest.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "full three-step ladder",
        includesAny: ["1h", "10m", "start", "Mac", "phone", "ack"],
      }),
      responseIncludesAny: ["1h", "10m", "start", "Mac", "phone"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to all three rungs (1h, 10m, start) on both Mac and phone, with one-ack-silences-rest behavior. Missing a rung or device fails.",
      },
    },
    {
      kind: "message",
      name: "ack-on-phone",
      room: "phone",
      text: "Got the 1h ping on my phone. Kill the rest of the ladder for this meeting.",
      responseIncludesAny: ["acknowledged", "stopped", "cleared", "kill"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must treat the phone ack as suppressing the remaining 10m + start rungs across both devices. Bare 'ok' fails.",
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
      name: "push-full-ladder-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "full ladder scheduling",
      }),
    },
    {
      type: "custom",
      name: "push-full-ladder-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        description: "ladder rungs dispatched across both devices",
        minCount: 2,
      }),
    },
    {
      type: "custom",
      name: "push-full-ladder-ack-suppress",
      predicate: expectStateTransition({
        subject: "deviceIntent",
        to: "acknowledged",
        description: "phone ack transitions device intent → acknowledged so the ladder stops",
      }),
    },
    judgeRubric({
      name: "push-full-ladder-rubric",
      threshold: 0.7,
      description:
        "End-to-end: 3-rung ladder scheduled on 2 devices and acknowledged once stops all remaining rungs.",
    }),
  ],
});
