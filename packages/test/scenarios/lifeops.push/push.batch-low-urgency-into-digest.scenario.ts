import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.batch-low-urgency-into-digest",
  title: "Batch low-urgency pushes into a single end-of-day digest",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "digest", "batch"],
  description:
    "Three low-urgency reminders are pending (newsletter draft, archive cleanup, weekly habit nudge). Rather than firing three separate pings, the agent must batch into one end-of-day digest push.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Low-urgency digest",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "pending-low-urgency-pushes",
        items: [
          { title: "Send newsletter draft", category: "writing" },
          { title: "Archive old email labels", category: "inbox" },
          { title: "Weekly habit: stretch 10m", category: "habit" },
        ],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "batch-digest",
      room: "main",
      text: "Don't ping me separately for low-urgency stuff — batch them into one digest at 6pm.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "batch low-urgency into digest",
        includesAny: ["digest", "batch", "6pm", "low-urgency"],
      }),
      responseIncludesAny: ["digest", "batch", "6pm", "low-urgency"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to ONE 6pm digest containing all three items — not three separate pings. Three separate pings, or a vague 'I'll batch', both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["desktop", "mobile"],
      actionName: ["DEVICE_INTENT"],
      minCount: 1,
    },
    {
      type: "custom",
      name: "push-batch-digest-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "digest batching",
      }),
    },
    {
      type: "custom",
      name: "push-batch-digest-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        actionName: ["DEVICE_INTENT"],
        description: "single digest dispatch (not three)",
        payloadIncludesAny: ["newsletter", "archive", "habit", "digest"],
      }),
    },
    judgeRubric({
      name: "push-batch-digest-rubric",
      threshold: 0.7,
      description: "Three items batched into one 6pm digest push.",
    }),
  ],
});
