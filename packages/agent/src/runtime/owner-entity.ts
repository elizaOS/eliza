import {
  type IAgentRuntime,
  resolveCanonicalOwnerId,
  stringToUuid,
} from "@elizaos/core";

type WorldMetadataShape = {
  ownership?: { ownerId?: string };
};

export function resolveFallbackOwnerEntityId(
  runtime: Pick<IAgentRuntime, "agentId" | "character">,
): string {
  const agentName = runtime.character?.name?.trim() || runtime.agentId;
  return stringToUuid(`${agentName}-admin-entity`);
}

export async function resolveOwnerEntityId(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const configuredOwnerId = resolveCanonicalOwnerId(runtime);
  if (configuredOwnerId) {
    return configuredOwnerId;
  }

  try {
    const roomIds = await runtime.getRoomsForParticipant(runtime.agentId);
    for (const roomId of roomIds.slice(0, 10)) {
      try {
        const room = await runtime.getRoom(roomId);
        if (!room?.worldId) {
          continue;
        }
        const world = await runtime.getWorld(room.worldId);
        const metadata = (world?.metadata ?? {}) as WorldMetadataShape;
        if (metadata.ownership?.ownerId) {
          return metadata.ownership.ownerId;
        }
      } catch {}
    }
  } catch {}

  return resolveFallbackOwnerEntityId(runtime);
}
