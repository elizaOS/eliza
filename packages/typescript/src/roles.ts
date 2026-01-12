import { createUniqueUuid } from "./entities";
import { logger } from "./logger";
import { type IAgentRuntime, Role, type UUID, type World } from "./types";

export interface ServerOwnershipState {
  servers: {
    [serverId: string]: World;
  };
}

export async function getUserServerRole(
  runtime: IAgentRuntime,
  entityId: string,
  serverId: string,
): Promise<Role> {
  const worldId = createUniqueUuid(runtime, serverId);
  const world = await runtime.getWorld(worldId);

  const worldMetadata = world?.metadata;
  const roles = worldMetadata?.roles;
  if (!roles) {
    return Role.NONE;
  }

  const role = roles[entityId as UUID];
  if (role) {
    return role as Role;
  }

  return Role.NONE;
}

export async function findWorldsForOwner(
  runtime: IAgentRuntime,
  entityId: string,
): Promise<World[] | null> {
  if (!entityId) {
    logger.error(
      { src: "core:roles", agentId: runtime.agentId },
      "User ID is required to find server",
    );
    return null;
  }

  const worlds = await runtime.getAllWorlds();

  if (!worlds || worlds.length === 0) {
    logger.debug(
      { src: "core:roles", agentId: runtime.agentId },
      "No worlds found for agent",
    );
    return null;
  }

  const ownerWorlds: World[] = [];
  for (const world of worlds) {
    const worldMetadata = world.metadata;
    const worldMetadataOwnership = worldMetadata?.ownership;
    if (worldMetadataOwnership && worldMetadataOwnership.ownerId === entityId) {
      ownerWorlds.push(world);
    }
  }

  return ownerWorlds.length ? ownerWorlds : null;
}
