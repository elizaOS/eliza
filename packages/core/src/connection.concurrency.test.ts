/**
 * Concurrent connection reconciliation against the production in-memory
 * adapter.
 *
 * `connection.test.ts` already pins the sequential guarantee: a connection that
 * omits a field preserves what an earlier connection wrote, and shared-world
 * metadata survives another caller reconciling. `ensureConnections` delivers
 * that with a read-merge-write — `getEntitiesByIds`/`getWorldsByIds`, merge,
 * then `upsertEntities`/`upsertWorlds` — and nothing orders two of those
 * cycles. The runtime serializes handler work per room, so two rooms sharing an
 * entity or a world overlap freely.
 */
import { describe, expect, it } from "vitest";
import { ensureConnection } from "./connection";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { stringToUuid } from "./utils";

describe("ensureConnection under concurrency", () => {
	it("preserves both connections' per-source entity identity", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("concurrent-entity-agent");
		const entityId = stringToUuid("concurrent-entity-person");
		const messageServerId = stringToUuid("concurrent-entity-server");

		const connect = (source: string, userName: string) =>
			ensureConnection(adapter, {
				agentId,
				entityId,
				roomId: stringToUuid(`concurrent-entity-room-${source}`),
				worldId: stringToUuid(`concurrent-entity-world-${source}`),
				messageServerId,
				source,
				channelId: `concurrent-entity-channel-${source}`,
				name: `Person via ${source}`,
				userName,
			});

		// One person reaching the same agent from two connectors at once.
		await Promise.all([
			connect("discord", "person#1234"),
			connect("telegram", "@person"),
		]);

		const [entity] = await adapter.getEntitiesByIds([entityId]);
		expect(entity?.metadata?.discord).toMatchObject({
			userName: "person#1234",
		});
		expect(entity?.metadata?.telegram).toMatchObject({ userName: "@person" });
		expect(entity?.names).toEqual(
			expect.arrayContaining(["Person via discord", "Person via telegram"]),
		);
	});

	it("preserves world metadata contributed by a concurrent caller", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("concurrent-world-agent");
		const worldId = stringToUuid("concurrent-world");
		const messageServerId = stringToUuid("concurrent-world-server");

		const connect = (who: string, metadata: Record<string, unknown>) =>
			ensureConnection(adapter, {
				agentId,
				entityId: stringToUuid(`concurrent-world-${who}`),
				roomId: stringToUuid(`concurrent-world-room-${who}`),
				worldId,
				messageServerId,
				source: "client_chat",
				channelId: `concurrent-world-channel-${who}`,
				metadata: metadata as never,
			});

		// Two participants joining the same shared world at once, each
		// contributing a key the other never mentions.
		await Promise.all([
			connect("first", { ownership: { ownerId: "owner-a" } }),
			connect("second", { invite: { code: "abc123" } }),
		]);

		const [world] = await adapter.getWorldsByIds([worldId]);
		expect(world?.metadata?.ownership).toMatchObject({ ownerId: "owner-a" });
		expect(world?.metadata?.invite).toMatchObject({ code: "abc123" });
	});

	it("keeps sequential reconciliation unchanged", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("sequential-entity-agent");
		const entityId = stringToUuid("sequential-entity-person");
		const messageServerId = stringToUuid("sequential-entity-server");

		const connect = (
			source: string,
			extra: {
				name?: string;
				userName?: string;
				userId?: ReturnType<typeof stringToUuid>;
			},
		) =>
			ensureConnection(adapter, {
				agentId,
				entityId,
				roomId: stringToUuid(`sequential-entity-room-${source}`),
				worldId: stringToUuid(`sequential-entity-world-${source}`),
				messageServerId,
				source,
				channelId: `sequential-entity-channel-${source}`,
				...extra,
			});

		await connect("discord", {
			name: "Person D",
			userName: "person#1234",
			userId: stringToUuid("sequential-entity-discord-id"),
		});
		// An aliasing connector deliberately omits `name`; it must not blank it.
		await connect("discord", { userName: "person#5678" });
		await connect("telegram", { name: "Person T", userName: "@person" });

		const [entity] = await adapter.getEntitiesByIds([entityId]);
		expect(entity?.metadata?.discord).toMatchObject({
			name: "Person D",
			userName: "person#5678",
			id: stringToUuid("sequential-entity-discord-id"),
		});
		expect(entity?.metadata?.telegram).toMatchObject({
			name: "Person T",
			userName: "@person",
		});
		expect(entity?.names).toEqual(
			expect.arrayContaining(["Person D", "person#1234", "Person T"]),
		);
	});

	it("still creates room participants for every concurrent connection", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("concurrent-participants-agent");
		const worldId = stringToUuid("concurrent-participants-world");
		const messageServerId = stringToUuid("concurrent-participants-server");
		const roomIds = ["a", "b", "c"].map((suffix) =>
			stringToUuid(`concurrent-participants-room-${suffix}`),
		);

		await Promise.all(
			roomIds.map((roomId, index) =>
				ensureConnection(adapter, {
					agentId,
					entityId: stringToUuid(`concurrent-participants-person-${index}`),
					roomId,
					worldId,
					messageServerId,
					source: "client_chat",
					channelId: `concurrent-participants-channel-${index}`,
				}),
			),
		);

		const participants = await adapter.getParticipantsForRooms(roomIds);
		for (const room of participants) {
			expect(room.entityIds).toContain(agentId);
			expect(room.entityIds).toHaveLength(2);
		}
	});
});
