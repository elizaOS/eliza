import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.cross-channel-escalation-if-chat-ignored",
  title: "Escalate to mobile push if a desktop chat message went 10 minutes unread",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "escalation", "cross-channel"],
  description:
    "An important question was sent on desktop and read receipt is still 'unseen' after 10m. Agent must escalate to mobile push — not just retry desktop.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-channel escalation",
    },
  ],
  seed: [
    {
      type: "advanceClock",
      by: "10m",
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "outbound-push-attempt",
        channel: "desktop",
        sentAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        readAt: null,
        priority: "high",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "escalate-to-mobile",
      room: "main",
      text: "The high-priority desktop ping is unread after 10 minutes. Escalate.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "desktop → mobile escalation",
        includesAny: ["mobile", "phone", "escalate", "10 minutes"],
      }),
      responseIncludesAny: ["mobile", "phone", "escalate"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must escalate to mobile push. Repeating desktop fails.",
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
      name: "push-cross-channel-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "cross-channel escalation",
      }),
    },
    {
      type: "custom",
      name: "push-cross-channel-dispatch",
      predicate: expectConnectorDispatch({
        channel: "mobile",
        actionName: ["DEVICE_INTENT"],
        description: "escalation hit mobile",
      }),
    },
    judgeRubric({
      name: "push-cross-channel-rubric",
      threshold: 0.7,
      description:
        "Agent escalated from desktop (unread 10m) to mobile push.",
    }),
  ],
});
