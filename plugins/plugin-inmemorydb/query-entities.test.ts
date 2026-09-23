/**
 * Exercises `queryEntities` against the real Map-backed adapter, proving that
 * explicit IDs intersect with component, scope, data, and paging predicates.
 */
import type { Component, Entity, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const otherAgentId = "00000000-0000-0000-0000-000000000002" as UUID;
const entityOne = "10000000-0000-0000-0000-000000000001" as UUID;
const entityTwo = "10000000-0000-0000-0000-000000000002" as UUID;
const entityThree = "10000000-0000-0000-0000-000000000003" as UUID;
const worldOne = "30000000-0000-0000-0000-000000000001" as UUID;
const worldTwo = "30000000-0000-0000-0000-000000000002" as UUID;
const roomId = "20000000-0000-0000-0000-000000000001" as UUID;

function entity(id: UUID): Entity {
  return { id, agentId, names: [`entity-${id}`] };
}

function component(
  id: UUID,
  entityId: UUID,
  type: string,
  worldId: UUID,
  data: Record<string, unknown>
): Component {
  return {
    id,
    entityId,
    agentId,
    roomId,
    worldId,
    sourceEntityId: entityOne,
    type,
    data,
    createdAt: 1,
  };
}

describe("plugin-inmemorydb queryEntities", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.initialize();
    await adapter.createEntities([entity(entityOne), entity(entityTwo), entity(entityThree)]);
    await adapter.createComponents([
      component("40000000-0000-0000-0000-000000000001" as UUID, entityOne, "profile", worldOne, {
        profile: { active: true },
        tags: ["alpha", "beta"],
      }),
      component("40000000-0000-0000-0000-000000000002" as UUID, entityOne, "secondary", worldTwo, {
        enabled: true,
      }),
      component("40000000-0000-0000-0000-000000000003" as UUID, entityTwo, "profile", worldOne, {
        profile: { active: false },
        tags: ["alpha"],
      }),
    ]);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("intersects every filter before paging and returns the documented components", async () => {
    const noMatch = await adapter.queryEntities({
      entityIds: [entityThree],
      componentType: "profile",
    });
    const page = await adapter.queryEntities({
      entityIds: [entityThree, entityTwo, entityOne],
      componentType: "profile",
      limit: 1,
    });
    const nestedDataMatch = await adapter.queryEntities({
      entityIds: [entityOne, entityTwo],
      componentDataFilter: { profile: { active: true }, tags: ["beta"] },
    });
    const worldMatch = await adapter.queryEntities({
      entityIds: [entityOne, entityTwo],
      worldId: worldTwo,
    });
    const wrongAgent = await adapter.queryEntities({
      entityIds: [entityOne],
      agentId: otherAgentId,
      limit: 1,
    });
    const allComponents = await adapter.queryEntities({
      entityIds: [entityOne],
      componentType: "profile",
      includeAllComponents: true,
    });

    expect(noMatch).toEqual([]);
    expect(page.map((item) => item.id)).toEqual([entityTwo]);
    expect(page[0].components?.map((item) => item.type)).toEqual(["profile"]);
    expect(nestedDataMatch.map((item) => item.id)).toEqual([entityOne]);
    expect(worldMatch.map((item) => item.id)).toEqual([entityOne]);
    expect(worldMatch[0].components?.map((item) => item.type)).toEqual(["secondary"]);
    expect(wrongAgent).toEqual([]);
    expect(allComponents[0].components?.map((item) => item.type).sort()).toEqual([
      "profile",
      "secondary",
    ]);
  });

  it.each([
    ["offset", -1],
    ["offset", 0.5],
    ["offset", Number.NaN],
    ["limit", -1],
    ["limit", Number.POSITIVE_INFINITY],
  ] as const)("rejects invalid %s pagination value %s", async (field, value) => {
    await expect(
      adapter.queryEntities({
        entityIds: [entityOne, entityTwo, entityThree],
        [field]: value,
      })
    ).rejects.toThrow(`queryEntities ${field} must be a non-negative safe integer`);
  });

  it("fails closed on accessor-bearing component filters before returning entities", async () => {
    let invoked = 0;
    const filter = Object.defineProperty({}, "role", {
      enumerable: true,
      get() {
        invoked += 1;
        return "admin";
      },
    });

    await expect(
      adapter.queryEntities({
        entityIds: [entityOne, entityTwo],
        componentDataFilter: filter,
      })
    ).rejects.toMatchObject({ code: "INMEMORY_FILTER_UNBOUNDED" });
    expect(invoked).toBe(0);
  });

  it("fails closed on an 8k filter at the real query boundary", async () => {
    const hostile = nestObj(8_000);
    await adapter.createComponents([
      component(
        "40000000-0000-0000-0000-000000000004" as UUID,
        entityThree,
        "profile",
        worldOne,
        hostile
      ),
    ]);

    await expect(
      adapter.queryEntities({
        entityIds: [entityThree],
        componentDataFilter: hostile,
      })
    ).rejects.toMatchObject({ code: "INMEMORY_FILTER_UNBOUNDED" });
  });
});

function nestObj(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { k: value };
  return value;
}
