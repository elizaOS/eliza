/**
 * Exercises merge-aware world ensure behavior against the real core in-memory
 * adapter, including repeated updates after the persisted revision advances.
 */

import { stringToUuid as sqliteTestAgentId } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/sqlite-adapter";
import { describe, expect, it } from "vitest";
import { ElizaError } from "./errors";
import { AgentRuntime } from "./runtime";
import type { Character, UUID, World } from "./types";
import { stringToUuid } from "./utils";

describe("AgentRuntime.ensureWorldExists", () => {
	it("rereads and merges after a concurrent creator wins the unique insert", async () => {
		const runtime = new AgentRuntime({
			character: { name: "ensure-world-create-race" } as Character,
		});
		const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
		let arrivals = 0;
		let release!: () => void;
		const bothArrived = new Promise<void>((resolve) => {
			release = resolve;
		});
		const racingAdapter = new Proxy(adapter, {
			get(target, property) {
				if (property === "upsertWorlds")
					return async (worlds: World[]) => {
						const arrival = ++arrivals;
						if (arrival > 2) return target.upsertWorlds(worlds);
						if (arrival === 2) release();
						await bothArrived;
						if (arrival === 1) return target.createWorlds(worlds);
						throw new ElizaError("World already exists", {
							code: "WORLD_ALREADY_EXISTS",
							context: { worldId: worlds[0]?.id },
						});
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await adapter.init();
		runtime.registerDatabaseAdapter(racingAdapter);
		const worldId = stringToUuid("ensure-world-create-race") as UUID;

		await Promise.all([
			runtime.ensureWorldExists({
				id: worldId,
				agentId: runtime.agentId,
				name: "raced",
				metadata: { first: "one" },
			}),
			runtime.ensureWorldExists({
				id: worldId,
				agentId: runtime.agentId,
				name: "raced",
				metadata: { second: "two" },
			}),
		]);

		const stored = (await adapter.getWorldsByIds([worldId]))[0];
		expect(stored?.metadata).toMatchObject({ first: "one", second: "two" });
	});

	it("reports a typed failure after bounded create-race retries", async () => {
		class PermanentlyRacedAdapter extends SQLiteDatabaseAdapter {
			override async upsertWorlds(worlds: World[]): Promise<void> {
				throw new ElizaError("World already exists", {
					code: "WORLD_ALREADY_EXISTS",
					context: { worldId: worlds[0]?.id },
				});
			}
		}
		const runtime = new AgentRuntime({
			character: { name: "ensure-world-create-race-exhausted" } as Character,
		});
		const adapter = PermanentlyRacedAdapter.create(":memory:", runtime.agentId);
		await adapter.init();
		runtime.registerDatabaseAdapter(adapter);

		await expect(
			runtime.ensureWorldExists({
				id: stringToUuid("ensure-world-create-race-exhausted") as UUID,
				agentId: runtime.agentId,
				name: "never-created",
			}),
		).rejects.toMatchObject({ code: "WORLD_ENSURE_CONFLICT_EXHAUSTED" });
	});

	it("merges repeated constructed-world updates with the persisted revision", async () => {
		const runtime = new AgentRuntime({
			character: { name: "ensure-world-test" } as Character,
		});
		const adapter = SQLiteDatabaseAdapter.create(
			":memory:",
			sqliteTestAgentId("ensure-world-test"),
		);
		await adapter.init();
		runtime.registerDatabaseAdapter(adapter);
		const worldId = stringToUuid("ensure-world-revision") as UUID;
		const serverId = stringToUuid("ensure-world-server") as UUID;

		await runtime.ensureWorldExists({
			id: worldId,
			agentId: runtime.agentId,
			name: "first",
			messageServerId: serverId,
			metadata: { first: "one" },
		});
		await runtime.ensureWorldExists({
			id: worldId,
			agentId: runtime.agentId,
			metadata: { second: "two" },
		});
		await runtime.ensureWorldExists({
			id: worldId,
			agentId: runtime.agentId,
			name: "third",
			metadata: { third: "three" },
		});

		const stored = (await adapter.getWorldsByIds([worldId]))[0] as World;
		expect(stored.name).toBe("third");
		expect(stored.messageServerId).toBe(serverId);
		expect(stored.metadata).toMatchObject({
			first: "one",
			second: "two",
			third: "three",
		});
	});

	it("preserves CAS-managed authority maps during connector-style ensure", async () => {
		const runtime = new AgentRuntime({
			character: { name: "ensure-world-authority-test" } as Character,
		});
		const adapter = SQLiteDatabaseAdapter.create(
			":memory:",
			sqliteTestAgentId("ensure-world-authority-test"),
		);
		await adapter.init();
		runtime.registerDatabaseAdapter(adapter);
		const worldId = stringToUuid("ensure-world-authority") as UUID;
		await runtime.ensureWorldExists({
			id: worldId,
			agentId: runtime.agentId,
			name: "authority",
			metadata: {
				roles: { admin: "ADMIN" },
				roleSources: { admin: "manual" },
			},
		});
		const before = (await adapter.getWorldsByIds([worldId]))[0] as World;
		await adapter.compareAndSwapWorldMetadata({
			worldId,
			expectedMetadata: before.metadata as never,
			replacementMetadata: structuredClone(before.metadata ?? {}) as never,
		});
		await runtime.ensureWorldExists({
			id: worldId,
			agentId: runtime.agentId,
			metadata: {
				roles: { owner: "OWNER" },
				roleSources: { owner: "connector" },
			},
		});
		const after = (await adapter.getWorldsByIds([worldId]))[0] as World;
		expect(after.metadata).toMatchObject({
			roles: { admin: "ADMIN" },
			roleSources: { admin: "manual" },
		});
	});
});
