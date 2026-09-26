/**
 * Resolves the entity id representing an agent's owner: prefers the canonical
 * configured owner id, otherwise scans the agent's rooms for a world whose
 * metadata carries ownership.ownerId, and finally falls back to core's
 * deterministic agent-ID-seeded owner id — the same fallback the chat,
 * and LifeOps surfaces use, so owner trust attaches to the entity those
 * surfaces write under. Lookup failures reject instead of selecting another identity. Used to attribute owner-scoped trust and permissions.
 */
import { ElizaError } from "./errors";
import { deterministicOwnerEntityId, resolveCanonicalOwnerId } from "./roles";
import type { IAgentRuntime } from "./types/runtime.js";

type WorldMetadataShape = {
	ownership?: { ownerId?: string };
};

export function resolveFallbackOwnerEntityId(
	runtime: Pick<IAgentRuntime, "agentId">,
): string {
	return deterministicOwnerEntityId(runtime.agentId);
}

export async function resolveOwnerEntityId(
	runtime: IAgentRuntime,
): Promise<string | null> {
	const configuredOwnerId = resolveCanonicalOwnerId(runtime);
	if (configuredOwnerId) {
		return configuredOwnerId;
	}

	let phase = "rooms";
	let roomId: string | undefined;
	let worldId: string | undefined;
	try {
		const roomIds = await runtime.getRoomsForParticipant(runtime.agentId);
		for (const candidateRoomId of roomIds) {
			phase = "room";
			roomId = candidateRoomId;
			worldId = undefined;
			const room = await runtime.getRoom(candidateRoomId);
			if (!room?.worldId) continue;
			phase = "world";
			worldId = room.worldId;
			const world = await runtime.getWorld(room.worldId);
			const metadata = (world?.metadata ?? {}) as WorldMetadataShape;
			if (metadata.ownership?.ownerId) return metadata.ownership.ownerId;
		}
	} catch (cause) {
		// error-policy:J2 an unreadable earlier world cannot establish owner precedence or absence.
		throw new ElizaError(
			"Owner identity lookup failed; restore storage access and retry.",
			{
				code: "OWNER_ENTITY_LOOKUP_FAILED",
				cause,
				context: { agentId: runtime.agentId, phase, roomId, worldId },
				severity: "ephemeral",
			},
		);
	}

	return resolveFallbackOwnerEntityId(runtime);
}
