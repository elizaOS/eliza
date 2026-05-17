import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.ntfy-delivery-receipt",
  title:
    "ntfy delivery receipt is persisted so the ladder knows not to escalate",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "ntfy", "receipt"],
  description:
    "After ntfy returns 200 with a delivery receipt, the agent must record the receipt against the push so the escalation ladder does NOT advance. Catches a bug where receipts are ignored and the ladder over-fires.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ntfy receipt",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "record-receipt",
      room: "main",
      text: "Send a desktop ping for the 11am sync via ntfy and record the delivery receipt so you don't escalate.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "ntfy push + receipt persistence",
        includesAny: ["ntfy", "receipt", "delivered", "ping"],
      }),
      responseIncludesAny: ["ntfy", "receipt", "delivered"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm the ntfy push fired AND that the delivery receipt was captured to stop the ladder. Just 'sent' fails — receipt persistence is the load-bearing assertion.",
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
      channel: "desktop",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "desktop",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "push-ntfy-receipt-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "ntfy + receipt",
      }),
    },
    {
      type: "custom",
      name: "push-ntfy-receipt-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "delivery receipt recorded",
        contentIncludesAny: ["receipt", "delivered", "ntfy"],
      }),
    },
    judgeRubric({
      name: "push-ntfy-receipt-rubric",
      threshold: 0.7,
      description:
        "ntfy delivery receipt persisted so the ladder won't over-escalate.",
    }),
  ],
});
