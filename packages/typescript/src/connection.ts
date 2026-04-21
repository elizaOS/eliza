/**
 * Standalone connection management: ensure entity/world/room/participants.
 * Batch-first: ensureConnections does 4 batch operations (upsertEntities, upsertWorlds,
 * upsertRooms, createRoomParticipants per room); ensureConnection is a single-connection wrapper.
 * Use these directly with adapter, or via runtime.ensureConnection() which delegates here.
 *
 * WHY standalone + batch: Callers can ensure many connections in one go without going through
 * the runtime; batch APIs reduce DB round-trips. Safe to use from both Node and edge entry points.
 */

import type { Entity, JsonValue, Metadata, Room, UUID, World } from "./types";
import { ChannelType } from "./types";
import type { IDatabaseAdapter } from "./types/database";
import { stringToUuid } from "./utils";

export interface EnsureConnectionParams {
	agentId: UUID;
	entityId: UUID;
	roomId: UUID;
	roomName?: string;
	/** Required if messageServerId is not provided. */
	worldId?: UUID;
	worldName?: string;
	userName?: string;
	name?: string;
	source: string;
	type?: ChannelType | string;
	channelId?: string;
	messageServerId?: UUID;
	userId?: UUID;
	metadata?: Record<string, JsonValue>;
}

export interface EnsureConnectionsParams {
	agentId: UUID;
	connections: EnsureConnectionParams[];
}

/** WHY: World is required for room hierarchy; derive a stable worldId from messageServerId when not provided. */
function resolveWorldId(
	worldId: UUID | undefined,
	messageServerId: UUID | undefined,
	agentId: UUID,
): UUID {
	if (worldId) return worldId;
	if (messageServerId) return stringToUuid(`${messageServerId}:${agentId}`);
	throw new Error("worldId or messageServerId is required");
}

/**
 * Batch: upsert entities, worlds, rooms; then add participants per room.
 * Uses 4 batch operations (upsertEntities, upsertWorlds, upsertRooms, createRoomParticipants per room).
 * WHY batch: Minimizes round-trips when syncing many connections (e.g. many users/rooms at once).
 */
export async function ensureConnections(
	adapter: IDatabaseAdapter,
	params: EnsureConnectionsParams,
): Promise<void> {
	const { agentId, connections } = params;
	if (!connections.length) return;

	const entityMap = new Map<
		string,
		{
			entityId: UUID;
			names: string[];
			metadata: Record<string, unknown>;
			agentId: UUID;
		}
	>();
	const worldMap = new Map<string, World>();
	const roomMap = new Map<string, Room>();
	const roomParticipants = new Map<string, Set<UUID>>();

	for (const c of connections) {
		const worldId = resolveWorldId(c.worldId, c.messageServerId, agentId);
		const names = [c.name, c.userName].filter(Boolean) as string[];
		const source = c.source || "default";
		const entityKey = c.entityId;
		if (!entityMap.has(entityKey)) {
			entityMap.set(entityKey, {
				entityId: c.entityId,
				names: [],
				metadata: {},
				agentId,
			});
		}
		const ent = entityMap.get(entityKey);
		if (!ent) {
			continue;
		}
		ent.names = [...new Set([...ent.names, ...names])].filter(Boolean);
		ent.metadata[source] = {
			id: c.userId,
			name: c.name,
			userName: c.userName,
		};

		const world: World = {
			id: worldId,
			name: c.worldName
				? c.worldName
				: c.messageServerId
					? `World for server ${c.messageServerId}`
					: `World for room ${c.roomId}`,
			agentId,
			messageServerId: c.messageServerId,
			metadata: c.metadata,
		};
		worldMap.set(worldId, world);

		const roomType =
			typeof c.type === "string" &&
			(Object.values(ChannelType) as string[]).includes(c.type)
				? (c.type as keyof typeof ChannelType)
				: ChannelType.DM;
		const room: Room = {
			id: c.roomId,
			name: c.roomName || c.name || "default",
			source,
			type: roomType,
			channelId: c.channelId ?? c.roomId,
			messageServerId: c.messageServerId,
			worldId,
		};
		roomMap.set(c.roomId, room);

		if (!roomParticipants.has(c.roomId)) {
			roomParticipants.set(c.roomId, new Set());
		}
		const participants = roomParticipants.get(c.roomId);
		if (!participants) {
			continue;
		}
		participants.add(c.entityId);
		participants.add(agentId);
	}

	const entityIds = [...entityMap.keys()];
	const existingEntities =
		entityIds.length > 0
			? await adapter.getEntitiesByIds(entityIds as UUID[])
			: [];
	const existingByKey = new Map(existingEntities.map((e) => [e.id, e]));
	const entities: Entity[] = [];
	for (const [, v] of entityMap) {
		const existing = existingByKey.get(v.entityId) ?? null;
		const names = existing
			? [...new Set([...(existing.names || []), ...v.names])].filter(Boolean)
			: v.names;
		const metadata = (
			existing ? { ...existing.metadata, ...v.metadata } : v.metadata
		) as Metadata;
		entities.push({
			id: v.entityId,
			names,
			metadata,
			agentId: v.agentId,
		});
	}
	if (entities.length) await adapter.upsertEntities(entities);

	const worlds = [...worldMap.values()].map((w) => ({
		...w,
		agentId,
	}));
	if (worlds.length) await adapter.upsertWorlds(worlds);

	const rooms = [...roomMap.values()].map((r) => ({
		...r,
		agentId,
	}));
	if (rooms.length) await adapter.upsertRooms(rooms);

	for (const [roomId, entityIdsSet] of roomParticipants) {
		const currentResult = await adapter.getParticipantsForRooms([
			roomId as UUID,
		]);
		const current = currentResult[0]?.entityIds ?? [];
		const missing = [...entityIdsSet].filter((id) => !current.includes(id));
		if (missing.length) {
			await adapter.createRoomParticipants(missing, roomId as UUID);
		}
	}
}

/**
 * Single-connection wrapper around ensureConnections.
 * WHY: Convenience for the common case of ensuring one entity/room; runtime.ensureConnection() uses this.
 */
export async function ensureConnection(
	adapter: IDatabaseAdapter,
	params: EnsureConnectionParams,
): Promise<void> {
	if (!params.source) {
		throw new Error("Source is required for ensureConnection");
	}
	const worldId = resolveWorldId(
		params.worldId,
		params.messageServerId,
		params.agentId,
	);
	await ensureConnections(adapter, {
		agentId: params.agentId,
		connections: [{ ...params, worldId }],
	});
}
