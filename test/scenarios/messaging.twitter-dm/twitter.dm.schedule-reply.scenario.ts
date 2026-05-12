import { listTriggerTasks, readTriggerConfig } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "twitter.dm.schedule-reply",
  title: "Schedule a Twitter/X DM reply for later delivery",
  domain: "messaging.twitter-dm",
  tags: ["messaging", "twitter", "routing", "trigger"],
  description:
    "A future-dated X DM reply should create a real trigger task instead of trying to send immediately through MESSAGE.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twitter DM Schedule Reply",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule reply",
      room: "main",
      text: "Schedule a reply to @devfriend's Twitter DM for 9am tomorrow saying thanks for the intro.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "scheduled X DM reply",
        includesAny: ["devfriend", "thanks for the intro", "send X DM"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "custom",
      name: "twitter-dm-schedule-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "scheduled X DM reply",
        includesAny: ["devfriend", "thanks for the intro", "send X DM"],
      }),
    },
    {
      type: "custom",
      name: "twitter-dm-schedule-creates-trigger",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const hit = ctx.actionsCalled.find(
          (entry) => entry.actionName === "MESSAGE",
        );
        const data =
          hit?.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as {
                taskId?: string | null;
                recipient?: string;
                text?: string;
                sendAtIso?: string;
              })
            : null;
        if (!data?.taskId || !data.recipient || !data.text || !data.sendAtIso) {
          return "expected scheduled X DM result to include taskId, recipient, text, and sendAtIso";
        }
        const tasks = await listTriggerTasks(runtime);
        const task = tasks.find((entry) => entry.id === data.taskId);
        if (!task) {
          return `expected trigger task ${data.taskId}`;
        }
        const trigger = readTriggerConfig(task);
        if (!trigger) {
          return "expected trigger metadata on the scheduled X DM task";
        }
        if (trigger.triggerType !== "once") {
          return `expected once trigger, got ${trigger.triggerType}`;
        }
        if (!trigger.instructions.includes("MESSAGE")) {
          return "expected trigger instructions to route through MESSAGE";
        }
        if (!trigger.instructions.includes(`recipient: ${data.recipient}`)) {
          return "expected trigger instructions to include the DM recipient";
        }
        if (!trigger.instructions.includes(data.text)) {
          return "expected trigger instructions to include the queued DM body";
        }
        return undefined;
      },
    },
  ],
});
