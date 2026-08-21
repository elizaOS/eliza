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

export interface EnsureConnectionsResult {
	createdRoomParticipants: number;
}

/**
 * One-level-deep merge for entity metadata keyed by connection source. A
 * top-level replace is how an owner-aliased author's fields used to overwrite
 * the canonical owner entity's identity record: each per-source object must
 * merge field-by-field, not swap wholesale, so a connection that omits a field
 * preserves what a previous connection wrote.
 */
function mergeEntitySourceMetadata(
	existing: Metadata,
	incoming: Record<string, unknown>,
): Metadata {
	const merged: Record<string, unknown> = { ...existing };
	for (const [key, value] of Object.entries(incoming)) {
		const prior = merged[key];
		if (
			prior !== null &&
			typeof prior === "object" &&
			!Array.isArray(prior) &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			merged[key] = { ...prior, ...value };
		} else {
			merged[key] = value;
		}
	}
	return merged as Metadata;
}

/**
 * Serializes the read-merge-write cycles that reconcile one entity or world.
 *
 * The merges above exist because a connection contributes fields without owning
 * the record — but they read with `getEntitiesByIds`/`getWorldsByIds`, merge,
 * and write back with `upsertEntities`/`upsertWorlds`, and the adapter write is
 * a whole-column replace with no transaction or optimistic-concurrency check.
 * Two reconciliations that overlap on one record therefore merge against the
 * same pre-write snapshot, and the later write silently discards whatever the
 * earlier one contributed. The runtime serializes handler work per room, so two
 * rooms that share an entity or a world overlap freely.
 */
const recordReconciliations = new Map<string, Promise<void>>();

function withRecordLock<T>(key: string, run: () => Promise<T>): Promise<T> {
	const predecessor = recordReconciliations.get(key) ?? Promise.resolve();
	const operation = predecessor.then(() => run());
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);
	recordReconciliations.set(key, tail);
	// A late tail retires only its own entry: a newer reconciliation may already
	// have installed its replacement, and deleting that would unserialize the
	// writers this map exists to order — and leak the key when it does not.
	void tail.then(() => {
		if (recordReconciliations.get(key) === tail) {
			recordReconciliations.delete(key);
		}
	});
	return operation;
}

/**
 * Hold every named record for the duration of `run`. Keys are acquired in a
 * stable sorted order so two batches with overlapping records can never take
 * them in opposite orders.
 */
function withRecordLocks<T>(keys: string[], run: () => Promise<T>): Promise<T> {
	const ordered = [...new Set(keys)].sort();
	const acquire = (index: number): Promise<T> => {
		const key = ordered[index];
		if (key === undefined) return run();
		return withRecordLock(key, () => acquire(index + 1));
	};
	return acquire(0);
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
): Promise<EnsureConnectionsResult> {
	const { agentId, connections } = params;
	if (!connections.length) return { createdRoomParticipants: 0 };

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
		// A connection contributes identity fields; it does not own the entity's
		// per-source identity record. Connectors that alias several platform
		// identities onto one canonical entity (e.g. Discord owner aliases)
		// deliberately omit these fields, and an omitted field must never blank
		// or replace what an earlier, genuine connection recorded.
		const sourceRecord: Record<string, JsonValue> = {};
		if (c.userId !== undefined) sourceRecord.id = c.userId;
		if (c.name !== undefined) sourceRecord.name = c.name;
		if (c.userName !== undefined) sourceRecord.userName = c.userName;
		if (Object.keys(sourceRecord).length > 0) {
			ent.metadata[source] = {
				...(ent.metadata[source] as Record<string, JsonValue> | undefined),
				...sourceRecord,
			};
		}

		const world: World = {
			id: worldId,
			name: c.worldName
				? c.worldName
				: c.messageServerId
					? `World for server ${c.messageServerId}`
					: `World for room ${c.roomId}`,
			agentId,
			messageServerId: c.messageServerId,
			metadata: {
				...(worldMap.get(worldId)?.metadata ?? {}),
				...(c.metadata ?? {}),
			},
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
	// The read, the merge and the write are one cycle per record: a concurrent
	// reconciliation that reads the same pre-write snapshot would otherwise
	// overwrite this one's contribution wholesale.
	await withRecordLocks(
		entityIds.map((id) => `entity:${id}`),
		async () => {
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
				const metadata = existing
					? mergeEntitySourceMetadata(
							(existing.metadata ?? {}) as Metadata,
							v.metadata,
						)
					: (v.metadata as Metadata);
				entities.push({
					id: v.entityId,
					names,
					metadata,
					agentId: v.agentId,
				});
			}
			if (entities.length) await adapter.upsertEntities(entities);
		},
	);

	const worldIds = [...worldMap.keys()] as UUID[];
	await withRecordLocks(
		worldIds.map((id) => `world:${id}`),
		async () => {
			const existingWorlds =
				worldIds.length > 0 ? await adapter.getWorldsByIds(worldIds) : [];
			const existingWorldsById = new Map(
				existingWorlds.map((world) => [world.id, world]),
			);
			const worlds = [...worldMap.values()].map((world) => {
				const existing = existingWorldsById.get(world.id);
				return {
					...existing,
					...world,
					agentId,
					// Connection establishment contributes metadata; it does not own the
					// full world document. Replacing this object erases durable role grants
					// every time another participant connects to the shared world.
					metadata: {
						...(existing?.metadata ?? {}),
						...(world.metadata ?? {}),
					},
				};
			});
			if (worlds.length) await adapter.upsertWorlds(worlds);
		},
	);

	const rooms = [...roomMap.values()].map((r) => ({
		...r,
		agentId,
	}));
	if (rooms.length) await adapter.upsertRooms(rooms);

	let createdRoomParticipants = 0;
	for (const [roomId, entityIdsSet] of roomParticipants) {
		const currentResult = await adapter.getParticipantsForRooms([
			roomId as UUID,
		]);
		const current = currentResult[0]?.entityIds ?? [];
		const missing = [...entityIdsSet].filter((id) => !current.includes(id));
		if (missing.length) {
			await adapter.createRoomParticipants(missing, roomId as UUID);
			createdRoomParticipants += missing.length;
		}
	}

	return { createdRoomParticipants };
}

/**
 * Single-connection wrapper around ensureConnections.
 * WHY: Convenience for the common case of ensuring one entity/room; runtime.ensureConnection() uses this.
 */
export async function ensureConnection(
	adapter: IDatabaseAdapter,
	params: EnsureConnectionParams,
): Promise<EnsureConnectionsResult> {
	if (!params.source) {
		throw new Error("Source is required for ensureConnection");
	}
	const worldId = resolveWorldId(
		params.worldId,
		params.messageServerId,
		params.agentId,
	);
	return ensureConnections(adapter, {
		agentId: params.agentId,
		connections: [{ ...params, worldId }],
	});
}
