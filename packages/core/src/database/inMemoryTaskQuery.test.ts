/** Verifies the core in-memory adapter's portable task filter and pagination contract. */

import { describe, expect, it } from "vitest";
import type { Task, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const OTHER_AGENT_ID = "10000000-0000-0000-0000-000000000002" as UUID;
const WORLD_ID = "10000000-0000-0000-0000-000000000003" as UUID;

function task(
	id: UUID,
	createdAt: number,
	overrides: Partial<Task> = {},
): Task {
	return {
		id,
		agentId: AGENT_ID,
		worldId: WORLD_ID,
		name: id,
		tags: ["queue", "task-query"],
		createdAt,
		...overrides,
	};
}

describe("core in-memory task queries", () => {
	it("filters authority and returns stable created-at/id pages", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const first = "10000000-0000-0000-0000-000000000010" as UUID;
		const second = "10000000-0000-0000-0000-000000000011" as UUID;
		const third = "10000000-0000-0000-0000-000000000012" as UUID;
		await adapter.createTasks([
			task(third, 20),
			task(second, 10),
			task(first, 10),
			task("10000000-0000-0000-0000-000000000013" as UUID, 1, {
				agentId: OTHER_AGENT_ID,
			}),
			task("10000000-0000-0000-0000-000000000014" as UUID, 1, {
				agentId: undefined,
			}),
		]);

		const query = {
			agentIds: [AGENT_ID],
			worldId: WORLD_ID,
			tags: ["queue", "task-query"],
		};
		await expect(
			adapter.getTasks({ ...query, limit: 2 }),
		).resolves.toMatchObject([{ id: first }, { id: second }]);
		await expect(
			adapter.getTasks({ ...query, limit: 1, offset: 2 }),
		).resolves.toMatchObject([{ id: third }]);
		await expect(adapter.getTasks({ agentIds: [] })).resolves.toEqual([]);
	});

	it.each([
		["negative limit", { limit: -1 }],
		["fractional limit", { limit: 1.5 }],
		["unsafe offset", { offset: Number.MAX_SAFE_INTEGER + 1 }],
	])("rejects %s", async (_label, pagination) => {
		const adapter = new InMemoryDatabaseAdapter();
		await expect(
			adapter.getTasks({ agentIds: [AGENT_ID], ...pagination }),
		).rejects.toThrow(/non-negative safe integer/u);
	});
});
