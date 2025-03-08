// File: /swarm/shared/ownership/core.ts
// Updated to use world metadata instead of cache

import { createUniqueUuid } from "./entities";
import { logger } from "./logger";
import { Role, type IAgentRuntime, type World } from "./types";

/**
 * Represents the state of server ownership, including a mapping of server IDs to their respective World objects.
 */
export interface ServerOwnershipState {
	servers: {
		[serverId: string]: World;
	};
}

/**
 * Gets a user's role from world metadata
 */
/**
 * Retrieve the server role of a specified user entity within a given server.
 * 
 * @param {IAgentRuntime} runtime - The runtime object containing necessary configurations and services.
 * @param {string} entityId - The unique identifier of the user entity.
 * @param {string} serverId - The unique identifier of the server.
 * @returns {Promise<Role>} The role of the user entity within the server, resolved as a Promise.
 */
export async function getUserServerRole(
	runtime: IAgentRuntime,
	entityId: string,
	serverId: string,
): Promise<Role> {
	try {
		const worldId = createUniqueUuid(runtime, serverId);
		const world = await runtime.getDatabaseAdapter().getWorld(worldId);

		if (!world || !world.metadata?.roles) {
			return Role.NONE;
		}

		if (world.metadata.roles[entityId]?.role) {
			return world.metadata.roles[entityId].role as Role;
		}

		// Also check original ID format
		if (world.metadata.roles[entityId]?.role) {
			return world.metadata.roles[entityId].role as Role;
		}

		return Role.NONE;
	} catch (error) {
		logger.error(`Error getting user role: ${error}`);
		return Role.NONE;
	}
}

/**
 * Finds a server where the given user is the owner
 */
export async function findWorldForOwner(
	runtime: IAgentRuntime,
	entityId: string,
): Promise<World | null> {
	try {
		if (!entityId) {
			logger.error("User ID is required to find server");
			return null;
		}

		// Get all worlds for this agent
		const worlds = await runtime.getDatabaseAdapter().getAllWorlds();

		if (!worlds || worlds.length === 0) {
			logger.info("No worlds found for this agent");
			return null;
		}

		// Find world where the user is the owner
		for (const world of worlds) {
			if (world.metadata?.ownership?.ownerId === entityId) {
				return world;
			}
		}

		logger.info(`No server found for owner ${entityId}`);
		return null;
	} catch (error) {
		logger.error(`Error finding server for owner: ${error}`);
		return null;
	}
}
