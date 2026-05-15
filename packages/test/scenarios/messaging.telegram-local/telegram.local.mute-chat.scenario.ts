import { listTriggerTasks, readTriggerConfig } from "@elizaos/agent";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "telegram.local.mute-chat",
  title: "Mute a named Telegram chat and queue an automatic unmute",
  domain: "messaging.telegram-local",
  tags: ["messaging", "telegram", "routing", "state-transition"],
  description:
    "A named Telegram chat should route through targeted chat-thread control, set the live mute state, and queue a real trigger to unmute it later.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-telegram-chat-room",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const ownerId = runtime.agentId;
        const worldId = stringToUuid(
          `scenario-telegram-world:${runtime.agentId}:crypto-signals`,
        ) as UUID;
        const roomId = stringToUuid(
          `scenario-telegram-room:${runtime.agentId}:crypto-signals`,
        ) as UUID;
        await runtime.ensureWorldExists({
          id: worldId,
          name: "Telegram Chats",
          agentId: runtime.agentId,
          messageServerId: ownerId,
          metadata: {
            ownership: { ownerId },
            roles: { [ownerId]: "OWNER", [runtime.agentId]: "ADMIN" },
            roleSources: { [ownerId]: "owner", [runtime.agentId]: "agent" },
          },
        });
        const existing = await runtime.getRoom(roomId);
        if (!existing) {
          await runtime.createRoom({
            id: roomId,
            name: "crypto signals",
            source: "telegram",
            type: ChannelType.GROUP,
            channelId: "telegram:crypto-signals",
            worldId,
            messageServerId: ownerId,
          });
        }
        const participants = await runtime.getParticipantsForRoom(roomId);
        if (!participants.includes(runtime.agentId)) {
          await runtime.createRoomParticipants([runtime.agentId], roomId);
        }
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Telegram Local Mute",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mute chat",
      room: "main",
      text: "Mute the 'crypto signals' Telegram group for 24 hours.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CHAT_THREAD"],
        description: "targeted Telegram mute control",
        includesAny: ["telegram", "crypto signals", "mute"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "CHAT_THREAD",
    },
    {
      type: "custom",
      name: "telegram-mute-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CHAT_THREAD"],
        description: "targeted Telegram mute control",
        includesAny: ["telegram", "crypto signals", "mute"],
      }),
    },
    {
      type: "custom",
      name: "telegram-mute-updates-state-and-queues-unmute",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const hit = ctx.actionsCalled.find(
          (entry) => entry.actionName === "CHAT_THREAD",
        );
        const data =
          hit?.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as {
                roomId?: string;
                platform?: string;
                muted?: boolean;
                scheduledTaskId?: string | null;
                scheduledAtIso?: string | null;
              })
            : null;
        if (!data?.roomId) {
          return "expected chat-thread control result to include roomId";
        }
        if (data.platform !== "telegram") {
          return `expected telegram platform, got ${data.platform ?? "(missing)"}`;
        }
        if (data.muted !== true) {
          return "expected muted=true in chat-thread control result";
        }
        const state = await runtime.getParticipantUserState(
          data.roomId as UUID,
          runtime.agentId,
        );
        if (state !== "MUTED") {
          return `expected live participant state MUTED, got ${state ?? "(missing)"}`;
        }
        if (!data.scheduledTaskId || !data.scheduledAtIso) {
          return "expected a scheduled unmute task for temporary Telegram mute";
        }
        const tasks = await listTriggerTasks(runtime);
        const task = tasks.find((entry) => entry.id === data.scheduledTaskId);
        if (!task) {
          return `expected trigger task ${data.scheduledTaskId}`;
        }
        const trigger = readTriggerConfig(task);
        if (!trigger?.instructions.includes("operation: unmute_chat")) {
          return "expected queued trigger instructions to unmute the chat";
        }
        if (!trigger.instructions.includes(data.roomId)) {
          return "expected queued trigger instructions to include the muted roomId";
        }
        return undefined;
      },
    },
  ],
});
