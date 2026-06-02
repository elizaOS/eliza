import { describe, expect, it } from "vitest";
import type { Component, Entity, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const otherAgentId = "00000000-0000-0000-0000-000000000002" as UUID;
const entityOne = "10000000-0000-0000-0000-000000000001" as UUID;
const entityTwo = "10000000-0000-0000-0000-000000000002" as UUID;
const entityThree = "10000000-0000-0000-0000-000000000003" as UUID;

function entity(id: UUID, scopedAgentId = agentId): Entity {
	return {
		id,
		agentId: scopedAgentId,
		names: [`entity-${id}`],
	};
}

function component(entityId: UUID): Component {
	return {
		id: `${entityId}-component` as UUID,
		entityId,
		agentId,
		roomId: "20000000-0000-0000-0000-000000000001" as UUID,
		worldId: "30000000-0000-0000-0000-000000000001" as UUID,
		sourceEntityId: agentId,
		type: "form_session:room",
		createdAt: 1,
		data: { id: entityId },
	};
}

describe("InMemoryDatabaseAdapter queryEntities", () => {
	it("supports bounded agent-scoped scans with components", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.createEntities([
			entity(entityOne),
			entity(entityTwo),
			entity(entityThree, otherAgentId),
		]);
		await adapter.createComponents([
			component(entityOne),
			component(entityTwo),
		]);

		const firstPage = await adapter.queryEntities({
			agentId,
			limit: 1,
			offset: 0,
			includeAllComponents: true,
		});
		const secondPage = await adapter.queryEntities({
			agentId,
			limit: 1,
			offset: 1,
			includeAllComponents: true,
		});

		expect(firstPage.map((item) => item.id)).toEqual([entityOne]);
		expect(firstPage[0].components).toHaveLength(1);
		expect(secondPage.map((item) => item.id)).toEqual([entityTwo]);
	});
});
