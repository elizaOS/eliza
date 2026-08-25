/**
 * Assembles message-driven access contexts. The base context resolves requester,
 * world, and role together; the cross-world conversation variant additionally
 * intersects verified linked-identity rooms with the agent's memberships so
 * storage can authorize multi-platform recall before ranking or pagination.
 */

import { getVerifiedRelatedEntityIds } from "./identity-clusters";
import {
	getLiveEntityMetadataFromMessage,
	resolveEntityRole,
	resolveWorldForMessage,
} from "./roles";
import type { AccessContext, IAgentRuntime, Memory } from "./types";

/**
 * Build the {@link AccessContext} for a message-driven read: who is asking, in
 * which world, and with what role.
 *
 * `worldId`, `role`, and `isOwner` are resolved together from the SINGLE world
 * that {@link resolveWorldForMessage} picks for the message — the room's
 * `worldId`, else the connector-metadata fallback (e.g. a Discord server/channel
 * id). Deriving all three from one resolution is load-bearing: resolving the
 * role against one world while reading `worldId` off a different path can yield
 * `role: "OWNER"` with `worldId: undefined` — an elevated role with no tenant
 * scope. Outside a world (DMs, or a message with no resolvable world) all three
 * are left undefined, which callers must treat as "no elevated access" rather
 * than "unrestricted".
 */
export async function buildAccessContext(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AccessContext> {
	const requesterEntityId = message.entityId;
	const source = message.content?.source;
	const sourceField = typeof source === "string" ? source : undefined;

	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) {
		return { requesterEntityId, source: sourceField };
	}

	const { world, metadata } = resolved;
	const role = await resolveEntityRole(
		runtime,
		world,
		metadata,
		requesterEntityId,
		{
			liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
			liveEntityId: requesterEntityId,
		},
	);

	return {
		requesterEntityId,
		worldId: world?.id,
		role,
		isOwner: role === "OWNER",
		source: sourceField,
	};
}

/**
 * Build the storage boundary for owner-private conversation continuity across
 * worlds. Authority still comes from the live delivery world, while the
 * readable room set is the intersection of the requester's verified identity
 * cluster and the agent's actual memberships. `worldId` is deliberately
 * omitted because that verified room set may span multiple platforms/worlds.
 */
export async function buildCrossWorldConversationAccessContext(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AccessContext> {
	const base = await buildAccessContext(runtime, message);
	const relatedEntityIds = await getVerifiedRelatedEntityIds(
		runtime,
		message.entityId,
	);
	const [requesterRoomIds, agentRoomIds] = await Promise.all([
		runtime.getRoomsForParticipants(relatedEntityIds),
		runtime.getRoomsForParticipant(runtime.agentId),
	]);
	const agentRooms = new Set(agentRoomIds);
	const authorizedRoomIds = Array.from(new Set(requesterRoomIds)).filter(
		(roomId) => agentRooms.has(roomId),
	);

	return {
		...base,
		worldId: undefined,
		authorizedRoomIds,
	};
}
