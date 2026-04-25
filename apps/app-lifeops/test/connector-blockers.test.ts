import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ChannelType,
  Memory,
  UUID,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";
import { crossPlatformGatewayAction } from "../src/actions/cross-platform-gateway.js";
import { chatThreadControlAction } from "../src/actions/chat-thread-control.js";
import { scheduleXDmReplyAction } from "../src/actions/schedule-x-dm-reply.js";
import {
  listTriggerTasks,
  readTriggerConfig,
} from "@elizaos/agent/triggers/runtime";

type RuntimeWithMaps = AgentRuntime & {
  createRoomParticipants(entityIds: UUID[], roomId: UUID): Promise<UUID[]>;
  ensureWorldExists(world: {
    id: UUID;
    name: string;
    agentId: UUID;
    messageServerId: UUID;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
};

function makeMemory(args: {
  agentId: UUID;
  entityId?: UUID;
  roomId?: UUID;
  text: string;
}): Memory {
  return {
    id: stringToUuid(
      `connector-blockers:${args.agentId}:${args.text}:${Math.random()}`,
    ) as UUID,
    agentId: args.agentId,
    entityId: (args.entityId ?? args.agentId) as UUID,
    roomId:
      (args.roomId ??
        (stringToUuid(`connector-blockers-room:${args.agentId}`) as UUID)),
    createdAt: Date.now(),
    content: {
      text: args.text,
      source: "dashboard",
    },
  } as Memory;
}

function createRuntime(agentId: string): RuntimeWithMaps {
  const runtime = createLifeOpsChatTestRuntime({
    agentId,
    useModel: async () => {
      throw new Error("useModel should not be called in connector blocker tests");
    },
    handleTurn: async () => ({ text: "ok" }),
  }) as RuntimeWithMaps;

  const entities = new Map<string, Record<string, unknown>>();
  const worlds = new Map<string, Record<string, unknown>>();
  const rooms = new Map<string, Record<string, unknown>>();
  const roomParticipants = new Map<string, Set<string>>();
  const participantStates = new Map<string, "FOLLOWED" | "MUTED" | null>();

  const stateKey = (roomId: UUID, entityId: UUID) => `${roomId}:${entityId}`;

  runtime.getEntityById = async (entityId: UUID) =>
    (entities.get(String(entityId)) as Awaited<
      ReturnType<AgentRuntime["getEntityById"]>
    >) ?? null;
  runtime.createEntity = async (entity) => {
    entities.set(String(entity.id), entity as Record<string, unknown>);
    return true;
  };
  runtime.getWorld = async (worldId: UUID) =>
    (worlds.get(String(worldId)) as Awaited<
      ReturnType<AgentRuntime["getWorld"]>
    >) ?? null;
  runtime.updateWorld = async (world) => {
    worlds.set(String(world.id), world as Record<string, unknown>);
  };
  runtime.createWorld = async (world) => {
    worlds.set(String(world.id), world as Record<string, unknown>);
    return world.id;
  };
  runtime.ensureWorldExists = async (world) => {
    worlds.set(String(world.id), world as Record<string, unknown>);
  };
  runtime.getRoom = async (roomId: UUID) =>
    (rooms.get(String(roomId)) as Awaited<
      ReturnType<AgentRuntime["getRoom"]>
    >) ?? null;
  runtime.createRoom = async (room) => {
    rooms.set(String(room.id), room as Record<string, unknown>);
    return room.id as UUID;
  };
  runtime.createRoomParticipants = async (entityIds: UUID[], roomId: UUID) => {
    const set = roomParticipants.get(String(roomId)) ?? new Set<string>();
    for (const entityId of entityIds) {
      set.add(String(entityId));
    }
    roomParticipants.set(String(roomId), set);
    return entityIds;
  };
  runtime.addParticipant = async (entityId: UUID, roomId: UUID) => {
    const set = roomParticipants.get(String(roomId)) ?? new Set<string>();
    set.add(String(entityId));
    roomParticipants.set(String(roomId), set);
    return true;
  };
  runtime.getParticipantsForRoom = async (roomId: UUID) =>
    [...(roomParticipants.get(String(roomId)) ?? new Set<string>())] as UUID[];
  runtime.getRoomsForParticipant = async (entityId: UUID) =>
    [...roomParticipants.entries()]
      .filter(([, participants]) => participants.has(String(entityId)))
      .map(([roomId]) => roomId as UUID);
  runtime.getParticipantUserState = async (roomId: UUID, entityId: UUID) =>
    participantStates.get(stateKey(roomId, entityId)) ?? null;
  runtime.updateParticipantUserState = async (
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null,
  ) => {
    participantStates.set(stateKey(roomId, entityId), state);
  };

  runtime.adapter.runPluginMigrations = async () => {
    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE IF NOT EXISTS life_intents (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              target TEXT NOT NULL,
              target_device_id TEXT,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              action_url TEXT,
              priority TEXT NOT NULL,
              created_at TEXT NOT NULL,
              expires_at TEXT,
              acknowledged_at TEXT,
              acknowledged_by TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}'
            );
          `,
        },
      ],
    });
  };
  runtime.runPluginMigrations = async () => {
    await runtime.adapter.runPluginMigrations?.();
  };

  return runtime;
}

describe("connector blocker actions", () => {
  let runtime: RuntimeWithMaps;

  beforeEach(async () => {
    runtime = createRuntime("connector-blocker-agent");
    await runtime.runPluginMigrations?.();
  });

  it("creates a real cross-platform group handoff room", async () => {
    const message = makeMemory({
      agentId: runtime.agentId,
      entityId: stringToUuid("connector-blocker-owner") as UUID,
      text: "Create a group chat with the agent and Alice on Discord.",
    });

    const result = await crossPlatformGatewayAction.handler?.(runtime, message, undefined, {
      parameters: {
        subaction: "create_group_chat",
        platform: "discord",
        participants: ["Alice"],
      },
    });

    expect(result?.success).toBe(true);
    const data = result?.data as {
      roomId: UUID;
      participantEntityIds: UUID[];
      platform: string;
    };
    expect(data.platform).toBe("discord");
    const room = await runtime.getRoom(data.roomId);
    expect(room?.source).toBe("discord");
    const participants = await runtime.getParticipantsForRoom(data.roomId);
    expect(participants).toContain(runtime.agentId);
    expect(participants).toContain(data.participantEntityIds[0]);
  });

  it("escalates a signature-required request into the intent store", async () => {
    const message = makeMemory({
      agentId: runtime.agentId,
      text: "Negotiate my lease renewal and sign it for me.",
    });

    const result = await crossPlatformGatewayAction.handler?.(runtime, message, undefined, {
      parameters: {
        subaction: "escalate_to_user",
        reason: "Lease renewal requires the owner to negotiate and sign directly.",
        title: "Owner action needed",
      },
    });

    expect(result?.success).toBe(true);
    const rows = await runtime.adapter.db.execute({
      queryChunks: [{ value: "SELECT * FROM life_intents" }],
    });
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.kind)).toBe("user_action_requested");
    expect(String(rows[0]?.body)).toContain("lease");
  });

  it("mutes a named Telegram chat and queues an automatic unmute", async () => {
    const ownerId = stringToUuid("connector-blocker-owner-telegram") as UUID;
    const worldId = stringToUuid("connector-blocker-telegram-world") as UUID;
    const roomId = stringToUuid("connector-blocker-telegram-room") as UUID;
    await runtime.ensureWorldExists({
      id: worldId,
      name: "Telegram",
      agentId: runtime.agentId,
      messageServerId: ownerId,
      metadata: {
        ownership: { ownerId },
        roles: { [ownerId]: "OWNER", [runtime.agentId]: "ADMIN" },
      },
    });
    await runtime.createRoom({
      id: roomId,
      name: "crypto signals",
      source: "telegram",
      type: "GROUP" as ChannelType,
      channelId: "telegram:crypto-signals",
      worldId,
      messageServerId: ownerId,
    });
    await runtime.createRoomParticipants([runtime.agentId], roomId);

    const message = makeMemory({
      agentId: runtime.agentId,
      text: "Mute the crypto signals Telegram group for 24 hours.",
    });
    const result = await chatThreadControlAction.handler?.(runtime, message, undefined, {
      parameters: {
        operation: "mute_chat",
        platform: "telegram",
        chatName: "crypto signals",
        durationMinutes: 24 * 60,
      },
    });

    expect(result?.success).toBe(true);
    expect(await runtime.getParticipantUserState(roomId, runtime.agentId)).toBe(
      "MUTED",
    );
    const data = result?.data as { scheduledTaskId?: UUID | null };
    const tasks = await listTriggerTasks(runtime);
    const task = tasks.find((entry) => entry.id === data.scheduledTaskId);
    expect(task).toBeTruthy();
    const trigger = task ? readTriggerConfig(task) : null;
    expect(trigger?.instructions).toContain("operation: unmute_chat");
    expect(trigger?.instructions).toContain(`roomId: ${roomId}`);
  });

  it("schedules an X DM reply as a real trigger task", async () => {
    const message = makeMemory({
      agentId: runtime.agentId,
      text: "Schedule an X reply.",
    });
    const sendAtIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await scheduleXDmReplyAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          recipient: "devfriend",
          text: "thanks for the intro",
          sendAtIso,
        },
      },
    );

    expect(result?.success).toBe(true);
    const data = result?.data as { taskId?: UUID | null };
    const tasks = await listTriggerTasks(runtime);
    const task = tasks.find((entry) => entry.id === data.taskId);
    expect(task).toBeTruthy();
    const trigger = task ? readTriggerConfig(task) : null;
    expect(trigger?.triggerType).toBe("once");
    expect(trigger?.instructions).toContain("REPLY_X_DM");
    expect(trigger?.instructions).toContain("recipient: devfriend");
    expect(trigger?.instructions).toContain("thanks for the intro");
  });
});
