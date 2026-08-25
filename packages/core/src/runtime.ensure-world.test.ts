/**
 * Exercises merge-aware world ensure behavior against the real core in-memory
 * adapter, including repeated updates after the persisted revision advances.
 */

import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { AgentRuntime } from "./runtime";
import type { Character, UUID, World } from "./types";
import { stringToUuid } from "./utils";

describe("AgentRuntime.ensureWorldExists", () => {
	it("merges repeated constructed-world updates with the persisted revision", async () => {
		const runtime = new AgentRuntime({
			character: { name: "ensure-world-test" } as Character,
		});
		const adapter = new InMemoryDatabaseAdapter();
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
		const adapter = new InMemoryDatabaseAdapter();
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
