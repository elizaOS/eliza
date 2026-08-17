/**
 * Tests `InMemoryDatabaseAdapter.queryEntities` — agent-scoped, component-aware
 * entity scans, intersections, and limit/offset paging against the real adapter.
 */
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

function component(
	entityId: UUID,
	overrides: Partial<Component> = {},
): Component {
	return {
		id: `${entityId}-component` as UUID,
		entityId,
		agentId,
		roomId: "20000000-0000-0000-0000-000000000001" as UUID,
		worldId: "30000000-0000-0000-0000-000000000001" as UUID,
		sourceEntityId: agentId,
		type: "form_session:room",
		createdAt: 1,
		data: { id: entityId, profile: { active: true }, tags: ["alpha", "beta"] },
		...overrides,
	};
}

describe("InMemoryDatabaseAdapter queryEntities", () => {
	it.each([
		["offset", -1],
		["offset", 1.5],
		["limit", Number.NaN],
		["limit", Number.POSITIVE_INFINITY],
	] as const)(
		"rejects invalid %s pagination value %s",
		async (field, value) => {
			const adapter = new InMemoryDatabaseAdapter();
			await expect(
				adapter.queryEntities({ entityIds: [entityOne], [field]: value }),
			).rejects.toThrow(
				`queryEntities ${field} must be a non-negative safe integer`,
			);
		},
	);

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

	it("intersects explicit entity ids with component filters", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.createEntities([entity(entityOne), entity(entityTwo)]);
		await adapter.createComponents([component(entityOne)]);

		const noMatch = await adapter.queryEntities({
			entityIds: [entityTwo],
			componentType: "form_session:room",
		});
		const partialMatch = await adapter.queryEntities({
			entityIds: [entityOne, entityTwo],
			componentType: "form_session:room",
		});
		const idsOnly = await adapter.queryEntities({ entityIds: [entityTwo] });

		expect(noMatch).toEqual([]);
		expect(partialMatch.map((item) => item.id)).toEqual([entityOne]);
		expect(partialMatch[0].components?.map((item) => item.type)).toEqual([
			"form_session:room",
		]);
		expect(idsOnly.map((item) => item.id)).toEqual([entityTwo]);
	});

	it("intersects data, world, agent, and paging filters before attaching components", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		const otherWorld = "30000000-0000-0000-0000-000000000002" as UUID;
		await adapter.createEntities([
			entity(entityOne),
			entity(entityTwo),
			entity(entityThree),
		]);
		await adapter.createComponents([
			component(entityOne),
			component(entityOne, {
				id: "40000000-0000-0000-0000-000000000002" as UUID,
				type: "secondary",
				worldId: otherWorld,
				data: { enabled: true },
			}),
			component(entityTwo, {
				id: "40000000-0000-0000-0000-000000000003" as UUID,
				data: { profile: { active: false }, tags: ["alpha"] },
			}),
		]);

		const page = await adapter.queryEntities({
			entityIds: [entityThree, entityTwo, entityOne],
			componentType: "form_session:room",
			limit: 1,
		});
		const nestedDataMatch = await adapter.queryEntities({
			entityIds: [entityOne, entityTwo],
			componentDataFilter: { profile: { active: true }, tags: ["beta"] },
		});
		const otherWorldMatch = await adapter.queryEntities({
			entityIds: [entityOne, entityTwo],
			worldId: otherWorld,
		});
		const wrongAgent = await adapter.queryEntities({
			entityIds: [entityOne],
			agentId: otherAgentId,
			limit: 1,
		});
		const allComponents = await adapter.queryEntities({
			entityIds: [entityOne],
			componentType: "form_session:room",
			includeAllComponents: true,
		});

		expect(page.map((item) => item.id)).toEqual([entityTwo]);
		expect(page[0].components?.map((item) => item.type)).toEqual([
			"form_session:room",
		]);
		expect(nestedDataMatch.map((item) => item.id)).toEqual([entityOne]);
		expect(otherWorldMatch.map((item) => item.id)).toEqual([entityOne]);
		expect(otherWorldMatch[0].components?.map((item) => item.type)).toEqual([
			"secondary",
		]);
		expect(wrongAgent).toEqual([]);
		expect(
			allComponents[0].components?.map((item) => item.type).sort(),
		).toEqual(["form_session:room", "secondary"]);
	});
});
