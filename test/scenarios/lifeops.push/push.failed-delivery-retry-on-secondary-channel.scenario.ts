import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.failed-delivery-retry-on-secondary-channel",
  title: "Failed ntfy delivery triggers a secondary-channel retry",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "ntfy", "retry", "fallback"],
  description:
    "Primary push via ntfy returned a delivery failure. Per the escalation ladder, the agent must retry via the next channel (SMS) — not silently drop or retry ntfy forever.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ntfy retry fallback",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "push-delivery-attempt",
        channel: "ntfy",
        topic: "eliza-shaw-mobile",
        result: "failed",
        statusCode: 503,
        attemptedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "retry-on-secondary",
      room: "main",
      text: "ntfy push failed with 503 — that was the meeting alert. Use the fallback channel.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "fallback after ntfy failure",
        includesAny: ["SMS", "fallback", "secondary", "retry"],
      }),
      responseIncludesAny: ["SMS", "fallback", "retry"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must fire on SMS (or another non-ntfy channel) and not retry ntfy. Retrying ntfy in a tight loop, or giving up, both fail.",
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
      channel: "sms",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "sms",
    },
    {
      type: "custom",
      name: "push-retry-secondary-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "secondary-channel retry",
      }),
    },
    {
      type: "custom",
      name: "push-retry-secondary-dispatch",
      predicate: expectConnectorDispatch({
        channel: "sms",
        description: "fallback dispatched on SMS",
      }),
    },
    judgeRubric({
      name: "push-retry-secondary-rubric",
      threshold: 0.7,
      description:
        "After ntfy 503, agent fired SMS fallback (not ntfy retry).",
    }),
  ],
});
