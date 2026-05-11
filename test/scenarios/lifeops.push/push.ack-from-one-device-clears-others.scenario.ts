import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectStateTransition,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.ack-from-one-device-clears-others",
  title: "Acknowledging on mobile clears the same notification on desktop + watch",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "ack", "multi-device-sync"],
  description:
    "Same DEVICE_INTENT was dispatched to desktop, mobile, and watch. User acks on mobile. Desktop and watch copies must transition to acknowledged. No stale copy left ringing.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Multi-device ack sync",
    },
    {
      id: "mobile",
      source: "discord",
      channelType: "DM",
      title: "Mobile ack room",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "device-intent",
        id: "di-board-call-meeting",
        title: "Board call at 3pm",
        dispatchedTo: ["desktop", "mobile", "watch"],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ack-mobile",
      room: "mobile",
      text: "Acking the 3pm board call reminder from mobile. Clear desktop and watch too.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "mobile ack syncs to other devices",
        includesAny: ["acknowledged", "cleared", "desktop", "watch"],
      }),
      responseIncludesAny: ["acknowledged", "cleared", "desktop", "watch"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm the desktop and watch copies were cleared together. Bare 'ok' fails — leaves stale notifications.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "pushAcknowledgedSync",
      expected: true,
    },
    {
      type: "custom",
      name: "push-ack-sync-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "ack synced cross-device",
      }),
    },
    {
      type: "custom",
      name: "push-ack-sync-transition",
      predicate: expectStateTransition({
        subject: "deviceIntent",
        to: "acknowledged",
        description: "device intent transitioned to acknowledged once any device acked",
      }),
    },
    judgeRubric({
      name: "push-ack-sync-rubric",
      threshold: 0.7,
      description:
        "Mobile ack cleared desktop + watch copies. No stale ringing.",
    }),
  ],
});
