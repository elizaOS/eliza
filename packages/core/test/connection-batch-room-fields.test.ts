/**
 * Regression: `ensureConnections` must not let a later connection in the
 * same batch blank fields an earlier connection recorded for the same room
 * (or world).
 *
 * The world builder already keeps an earlier connection's name in-batch
 * (`c.worldName || worldMap.get(worldId)?.name`), and the room write step
 * already falls back to the *stored* room — but the room builder itself
 * overwrote the batched entry wholesale (`name: c.roomName || undefined`,
 * `channelId: c.channelId`, ...), so when the second connection for the
 * same room omitted those fields the first connection's room name,
 * channel id and server binding were lost on a fresh database. The world
 * builder had the same hole for `messageServerId`.
 */

import { describe, expect, it } from "vitest";
import { ensureConnections } from "../src/connection";
import type { IDatabaseAdapter } from "../src/types/database";
import type { Entity, Room, World } from "../src/types/environment.js";
import type { UUID } from "../src/types/primitives.js";
import { stringToUuid } from "../src/utils/string-to-uuid.js";

class FakeAdapter {
	entities = new Map<string, Entity>();
	worlds = new Map<string, World>();
	rooms = new Map<string, Room>();
	participants = new Map<string, Set<string>>();

	async getEntitiesByIds(ids: UUID[]): Promise<Entity[]> {
		return ids.flatMap((id) => {
			const entity = this.entities.get(id);
			return entity ? [entity] : [];
		});
	}

	async upsertEntities(entities: Entity[]): Promise<void> {
		for (const entity of entities) {
			if (entity.id) this.entities.set(entity.id, entity);
		}
	}

	async getWorldsByIds(ids: UUID[]): Promise<World[]> {
		return ids.flatMap((id) => {
			const world = this.worlds.get(id);
			return world ? [world] : [];
		});
	}

	async upsertWorlds(worlds: World[]): Promise<void> {
		for (const world of worlds) this.worlds.set(world.id, world);
	}

	async getRoomsByIds(ids: UUID[]): Promise<Room[]> {
		return ids.flatMap((id) => {
			const room = this.rooms.get(id);
			return room ? [room] : [];
		});
	}

	async upsertRooms(rooms: Room[]): Promise<void> {
		for (const room of rooms) this.rooms.set(room.id, room);
	}

	async getParticipantsForRooms(
		roomIds: UUID[],
	): Promise<{ roomId: UUID; entityIds: UUID[] }[]> {
		return roomIds.map((roomId) => ({
			roomId,
			entityIds: [...(this.participants.get(roomId) ?? [])],
		}));
	}

	async createRoomParticipants(
		entityIds: UUID[],
		roomId: UUID,
	): Promise<UUID[]> {
		const set = this.participants.get(roomId) ?? new Set<string>();
		for (const id of entityIds) set.add(id);
		this.participants.set(roomId, set);
		return entityIds;
	}
}

describe("ensureConnections batch room fields", () => {
	it("keeps an earlier connection's room fields when a later one omits them", async () => {
		const agentId = stringToUuid("connection-batch-room-agent");
		const adapter = new FakeAdapter();
		const entityA = stringToUuid("connection-batch-room-entity-a");
		const entityB = stringToUuid("connection-batch-room-entity-b");
		const roomId = stringToUuid("connection-batch-room-room");
		const worldId = stringToUuid("connection-batch-room-world");
		const messageServerId = stringToUuid("connection-batch-room-server");

		await ensureConnections(adapter as unknown as IDatabaseAdapter, {
			agentId,
			connections: [
				{
					agentId,
					entityId: entityA,
					roomId,
					worldId,
					messageServerId,
					serverId: "223456789012345678",
					channelId: "323456789012345678",
					roomName: "General",
					source: "discord",
				},
				{
					agentId,
					entityId: entityB,
					roomId,
					worldId,
					source: "discord",
				},
			],
		});

		const [room] = await adapter.getRoomsByIds([roomId]);
		expect(room).toMatchObject({
			id: roomId,
			name: "General",
			channelId: "323456789012345678",
			serverId: "223456789012345678",
			messageServerId,
		});

		const [world] = await adapter.getWorldsByIds([worldId]);
		expect(world?.messageServerId).toBe(messageServerId);
	});
});
