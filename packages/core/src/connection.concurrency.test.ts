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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureConnection, ensureConnections } from "./connection";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { logger } from "./logger";
import type { Entity } from "./types";
import { stringToUuid } from "./utils";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

class HoldingEntityAdapter extends InMemoryDatabaseAdapter {
	readonly entityWriteStarted = deferred();
	readonly releaseEntityWrite = deferred();

	override async upsertEntities(entities: Entity[]): Promise<void> {
		this.entityWriteStarted.resolve();
		await this.releaseEntityWrite.promise;
		await super.upsertEntities(entities);
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

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

	it("warns when a reconciliation holds a record lock past the diagnostic threshold", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const adapter = new HoldingEntityAdapter();
		const entityId = stringToUuid("stuck-lock-entity");
		const reconciliation = ensureConnection(adapter, {
			agentId: stringToUuid("stuck-lock-agent"),
			entityId,
			roomId: stringToUuid("stuck-lock-room"),
			worldId: stringToUuid("stuck-lock-world"),
			source: "client_chat",
		});

		try {
			await vi.advanceTimersByTimeAsync(0);
			await adapter.entityWriteStarted.promise;
			await vi.advanceTimersByTimeAsync(30_000);

			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({
					key: `entity:${entityId}`,
					thresholdMs: 30_000,
				}),
				"Connection reconciliation lock is still held",
			);
		} finally {
			adapter.releaseEntityWrite.resolve();
			await vi.advanceTimersByTimeAsync(0);
			await reconciliation;
		}
	});

	it("does not serialize identical record ids across independent adapters", async () => {
		const firstAdapter = new HoldingEntityAdapter();
		const secondAdapter = new InMemoryDatabaseAdapter();
		const secondWriteStarted = deferred();
		const originalSecondUpsert =
			secondAdapter.upsertEntities.bind(secondAdapter);
		secondAdapter.upsertEntities = async (entities: Entity[]) => {
			secondWriteStarted.resolve();
			await originalSecondUpsert(entities);
		};
		const shared = {
			agentId: stringToUuid("adapter-scope-agent"),
			entityId: stringToUuid("adapter-scope-entity"),
			roomId: stringToUuid("adapter-scope-room"),
			worldId: stringToUuid("adapter-scope-world"),
			source: "client_chat",
		};

		const first = ensureConnection(firstAdapter, shared);
		await firstAdapter.entityWriteStarted.promise;
		const second = ensureConnection(secondAdapter, shared);

		try {
			const independentWriteStarted = await Promise.race([
				secondWriteStarted.promise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
			]);
			expect(independentWriteStarted).toBe(true);
		} finally {
			firstAdapter.releaseEntityWrite.resolve();
			await Promise.all([first, second]);
		}
	});

	it("allows a successor reconciliation after the predecessor rejects", async () => {
		class RejectFirstEntityWriteAdapter extends InMemoryDatabaseAdapter {
			private entityWrites = 0;

			override async upsertEntities(entities: Entity[]): Promise<void> {
				this.entityWrites += 1;
				if (this.entityWrites === 1) {
					throw new Error("injected first entity write failure");
				}
				await super.upsertEntities(entities);
			}
		}

		const adapter = new RejectFirstEntityWriteAdapter();
		const shared = {
			agentId: stringToUuid("reject-successor-agent"),
			entityId: stringToUuid("reject-successor-entity"),
			worldId: stringToUuid("reject-successor-world"),
			source: "client_chat",
		};
		const results = await Promise.allSettled([
			ensureConnection(adapter, {
				...shared,
				roomId: stringToUuid("reject-successor-first-room"),
			}),
			ensureConnection(adapter, {
				...shared,
				roomId: stringToUuid("reject-successor-second-room"),
			}),
		]);

		expect(results[0]).toMatchObject({
			status: "rejected",
			reason: new Error("injected first entity write failure"),
		});
		expect(results[1]).toMatchObject({ status: "fulfilled" });
	});

	it("acquires reverse-overlap batches in sorted order without deadlock", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("reverse-overlap-agent");
		const firstEntityId = stringToUuid("reverse-overlap-first-entity");
		const secondEntityId = stringToUuid("reverse-overlap-second-entity");
		const firstWorldId = stringToUuid("reverse-overlap-first-world");
		const secondWorldId = stringToUuid("reverse-overlap-second-world");
		const makeConnection = (
			entityId: typeof firstEntityId,
			suffix: string,
		) => ({
			agentId,
			entityId,
			roomId: stringToUuid(`reverse-overlap-${suffix}-room`),
			worldId: suffix.includes("first") ? firstWorldId : secondWorldId,
			source: "client_chat",
		});

		const batches = Promise.all([
			ensureConnections(adapter, {
				agentId,
				connections: [
					makeConnection(firstEntityId, "first-a"),
					makeConnection(secondEntityId, "second-a"),
				],
			}),
			ensureConnections(adapter, {
				agentId,
				connections: [
					makeConnection(secondEntityId, "second-b"),
					makeConnection(firstEntityId, "first-b"),
				],
			}),
		]);
		const completed = await Promise.race([
			batches.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
		]);

		expect(completed).toBe(true);
	});

	it("retires the adapter's reconciliation registry after settlement", async () => {
		const connectionModule = (await import("./connection")) as Record<
			string,
			unknown
		>;
		const getRegistrySize =
			connectionModule.__getConnectionReconciliationRegistrySizeForTests;
		expect(typeof getRegistrySize).toBe("function");
		if (typeof getRegistrySize !== "function") return;

		const adapter = new HoldingEntityAdapter();
		const reconciliation = ensureConnection(adapter, {
			agentId: stringToUuid("registry-retirement-agent"),
			entityId: stringToUuid("registry-retirement-entity"),
			roomId: stringToUuid("registry-retirement-room"),
			worldId: stringToUuid("registry-retirement-world"),
			source: "client_chat",
		});

		await adapter.entityWriteStarted.promise;
		expect(getRegistrySize(adapter)).toBe(1);
		adapter.releaseEntityWrite.resolve();
		await reconciliation;
		await Promise.resolve();
		expect(getRegistrySize(adapter)).toBe(0);
	});
});
