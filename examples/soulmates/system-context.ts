import {
  ChannelType,
  type IAgentRuntime,
  type Metadata,
  type UUID,
} from "@elizaos/core";

export type SystemContext = {
  roomId: UUID;
  worldId: UUID;
};

export async function ensureSystemContext(
  runtime: IAgentRuntime,
): Promise<SystemContext> {
  const worldId = runtime.agentId as UUID;
  const roomId = runtime.agentId as UUID;
  const worldName = `${runtime.character.name ?? "Agent"} World`;
  const roomName = `${runtime.character.name ?? "Agent"} System`;

  const worldMetadata: Metadata = { type: "system" };
  const roomMetadata: Metadata = { purpose: "system" };

  await runtime.ensureWorldExists({
    id: worldId,
    name: worldName,
    messageServerId: worldId,
    agentId: runtime.agentId,
    metadata: worldMetadata,
  });

  await runtime.ensureRoomExists({
    id: roomId,
    name: roomName,
    source: "soulmates",
    type: ChannelType.SELF,
    channelId: roomId,
    messageServerId: roomId,
    worldId,
    metadata: roomMetadata,
  });

  return { roomId, worldId };
}
