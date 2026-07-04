/**
 * Storage context helpers for music components that need room or agent scope.
 *
 * Room-scoped helpers require an existing world, while agent-scoped helpers
 * create deterministic backing world and room records.
 */
import {
  createUniqueUuid,
  type IAgentRuntime,
  type Room,
  type UUID,
} from "@elizaos/core";

interface RoomContext {
  room: Room;
  roomId: UUID;
  worldId: UUID;
}

interface StorageContext {
  roomId: UUID;
  worldId: UUID;
}

export async function requireRoomContext(
  runtime: IAgentRuntime,
  roomId: UUID,
  featureName: string,
): Promise<RoomContext> {
  const room = await runtime.getRoom(roomId);
  if (!room) {
    throw new Error(`[${featureName}] Room ${roomId} not found`);
  }

  if (!room.worldId) {
    throw new Error(`[${featureName}] Room ${roomId} is missing worldId`);
  }

  return {
    room,
    roomId,
    worldId: room.worldId as UUID,
  };
}

export async function ensureAgentStorageContext(
  runtime: IAgentRuntime,
  purpose: string,
  source: string,
): Promise<StorageContext> {
  const worldId = createUniqueUuid(runtime, `${purpose}-world`);
  const roomId = createUniqueUuid(runtime, `${purpose}-room`);

  await runtime.ensureWorldExists({
    id: worldId,
    name: `${purpose} World`,
    agentId: runtime.agentId,
    metadata: { purpose },
  });

  await runtime.ensureRoomExists({
    id: roomId,
    name: `${purpose} Room`,
    source,
    type: "GROUP" as Room["type"],
    channelId: roomId,
    serverId: roomId,
    worldId,
    metadata: { purpose },
  });

  return { roomId, worldId };
}
