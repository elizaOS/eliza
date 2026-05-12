import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.urgent-bypasses-do-not-disturb",
  title: "Mom-flagged urgent push fires through Do Not Disturb",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "urgent", "dnd", "bypass"],
  description:
    "Do Not Disturb is on. Mom is messaging — and her contact carries a top-priority/interrupt rule. The push must fire through DnD on mobile. Negative-space: pushes that are NOT mom/urgent should still be suppressed during DnD; that's covered by a sibling scenario.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Urgent bypass DnD",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "user-state",
        doNotDisturb: true,
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "inbound-message",
        from: "Linda (Mom)",
        relationship: "mom",
        priority: "interrupt",
        text: "I need to talk to you ASAP, please call me.",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "urgent-bypass",
      room: "main",
      text: "DnD is on but mom said it's urgent. Push it through.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "urgent bypass DnD",
        includesAny: ["mom", "urgent", "bypass", "interrupt"],
      }),
      responseIncludesAny: ["mom", "urgent", "bypass", "interrupt"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must fire the mobile push through DnD because of mom's interrupt rule. Suppressing because DnD = on, ignoring mom's relationship, fails.",
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
      channel: "mobile",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "mobile",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "custom",
      name: "push-urgent-bypass-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "urgent push bypasses DnD",
      }),
    },
    {
      type: "custom",
      name: "push-urgent-bypass-dispatch",
      predicate: expectConnectorDispatch({
        channel: "mobile",
        actionName: ["DEVICE_INTENT"],
        description: "urgent push made it through to mobile",
      }),
    },
    judgeRubric({
      name: "push-urgent-bypass-rubric",
      threshold: 0.7,
      description:
        "Mom-urgent push fired through DnD on mobile.",
    }),
  ],
});
