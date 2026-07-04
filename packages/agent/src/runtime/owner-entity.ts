/**
 * Resolves the entity id representing an agent's owner: prefers the canonical
 * configured owner id, otherwise scans the agent's rooms for a world whose
 * metadata carries ownership.ownerId, and finally falls back to a deterministic
 * synthetic id derived from the character name. Used to attribute owner-scoped
 * trust and permissions.
 */
import {
  type IAgentRuntime,
  logger,
  resolveCanonicalOwnerId,
  stringToUuid,
} from "@elizaos/core";

type WorldMetadataShape = {
  ownership?: { ownerId?: string };
};

export function resolveFallbackOwnerEntityId(
  runtime: Pick<IAgentRuntime, "agentId" | "character">,
): string {
  const agentName = runtime.character.name?.trim() || runtime.agentId;
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
      } catch (error) {
        logger.debug(
          `[owner-entity] World ownership lookup failed for room ${roomId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    logger.warn(
      `[owner-entity] Failed to resolve owner from world metadata; falling back to synthetic owner id: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return resolveFallbackOwnerEntityId(runtime);
}
