/**
 * Revalidates structural server-management authority against one exact durable
 * room/world binding. Both core dispatch and connector mutation boundaries call
 * this function; no display name, live provider enumeration, or source-world
 * role can authorize a different destination.
 */

import { ElizaError } from "../errors.ts";
import {
	getVerifiedRelatedEntityIds,
	invalidateRelatedEntityIds,
} from "../identity-clusters.ts";
import {
	hasAtLeastRole,
	type RolesWorldMetadata,
	resolveEntityRole,
} from "../roles.ts";
import type {
	IAgentRuntime,
	MessageConnectorManageServerAuthorization,
	MessageConnectorManageServerDestination,
	UUID,
} from "../types/index.ts";

function metadataAccountId(metadata: unknown): string | undefined {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return undefined;
	}
	const accountId = (metadata as Record<string, unknown>).accountId;
	return typeof accountId === "string" && accountId.length > 0
		? accountId
		: undefined;
}

function deny(
	code: string,
	message: string,
	destination: MessageConnectorManageServerDestination,
): never {
	throw new ElizaError(message, {
		code,
		context: {
			source: destination.source,
			accountId: destination.accountId,
			serverId: destination.serverId,
			destinationWorldId: destination.destinationWorldId,
		},
	});
}

/**
 * Resolve the requester's verified identity cluster afresh, intersect its rooms
 * with the agent's rooms, and require ADMIN+ in the exact destination world.
 */
export async function authorizeManageServerDestination(
	runtime: IAgentRuntime,
	requesterEntityId: UUID,
	destination: MessageConnectorManageServerDestination,
): Promise<MessageConnectorManageServerAuthorization> {
	const world = await runtime.getWorld(destination.destinationWorldId);
	if (
		!world ||
		world.agentId !== runtime.agentId ||
		world.messageServerId !== destination.messageServerId
	) {
		deny(
			"MANAGE_SERVER_DESTINATION_UNBOUND",
			"The requested server is not bound to a durable world for this agent.",
			destination,
		);
	}
	const serverRooms = (await runtime.getRooms(world.id)).filter(
		(room) =>
			room.worldId === world.id &&
			room.source === destination.source &&
			room.serverId === destination.serverId &&
			room.messageServerId === destination.messageServerId,
	);
	const destinationRooms = serverRooms.filter(
		(room) => metadataAccountId(room.metadata) === destination.accountId,
	);
	if (destinationRooms.length === 0) {
		if (serverRooms.length > 0) {
			deny(
				"MANAGE_SERVER_DESTINATION_ACCOUNT_MISMATCH",
				"The requested server room binding does not belong to the selected connector account.",
				destination,
			);
		}
		deny(
			"MANAGE_SERVER_DESTINATION_UNBOUND",
			"The requested server has no exact persisted room binding for the selected connector account.",
			destination,
		);
	}

	// The connector boundary calls this after the planner-side check. Drop the
	// turn memo so revocation or identity-link changes cannot inherit the earlier
	// identity-cluster snapshot.
	invalidateRelatedEntityIds(runtime, requesterEntityId);
	const requesterEntityIds = await getVerifiedRelatedEntityIds(
		runtime,
		requesterEntityId,
	);
	const [requesterRoomLists, agentRoomIds] = await Promise.all([
		Promise.all(
			requesterEntityIds.map((entityId) =>
				runtime.getRoomsForParticipant(entityId),
			),
		),
		runtime.getRoomsForParticipant(runtime.agentId),
	]);
	const agentRooms = new Set(agentRoomIds);
	const destinationRoomIds = new Set(destinationRooms.map((room) => room.id));

	for (let index = 0; index < requesterEntityIds.length; index += 1) {
		const entityId = requesterEntityIds[index];
		if (!entityId) continue;
		const sharedDestinationRoomIds = Array.from(
			new Set(requesterRoomLists[index] ?? []),
		).filter(
			(roomId) => agentRooms.has(roomId) && destinationRoomIds.has(roomId),
		);
		if (sharedDestinationRoomIds.length === 0) continue;
		const role = await resolveEntityRole(
			runtime,
			world,
			world.metadata as RolesWorldMetadata | undefined,
			entityId,
		);
		if (!hasAtLeastRole(role, "ADMIN")) continue;
		return {
			...destination,
			requesterEntityId,
			authorizedEntityId: entityId,
			role: role === "OWNER" ? "OWNER" : "ADMIN",
			bindingRoomIds: sharedDestinationRoomIds,
		};
	}

	deny(
		"MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED",
		"The verified requester is not an ADMIN or OWNER member of the requested server world.",
		destination,
	);
}
