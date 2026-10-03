/**
 * Runs the entity-query intersection contract against a real isolated PGlite
 * or PostgreSQL database, including JSONB containment and component hydration.
 */
import {
  ChannelType,
  type Component,
  type Entity,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { inArray, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { entityTable } from "../../schema/entity";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("queryEntities intersection contract", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  const otherAgentId = uuidv4() as UUID;
  const entityOne = uuidv4() as UUID;
  const entityTwo = uuidv4() as UUID;
  const entityThree = uuidv4() as UUID;
  const worldOne = uuidv4() as UUID;
  const worldTwo = uuidv4() as UUID;
  const roomOne = uuidv4() as UUID;
  const roomTwo = uuidv4() as UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("query-entities-intersection");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;

    await adapter.createWorlds([
      { id: worldOne, agentId, name: "World one", serverId: worldOne } as World,
      { id: worldTwo, agentId, name: "World two", serverId: worldTwo } as World,
    ]);
    await adapter.createRooms([
      {
        id: roomOne,
        agentId,
        worldId: worldOne,
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
      {
        id: roomTwo,
        agentId,
        worldId: worldTwo,
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities(
      [entityOne, entityTwo, entityThree].map(
        (id): Entity => ({ id, agentId, names: [`entity-${id}`] })
      )
    );
    await adapter.createComponents([
      {
        id: uuidv4() as UUID,
        entityId: entityOne,
        agentId,
        roomId: roomOne,
        worldId: worldOne,
        sourceEntityId: entityOne,
        type: "profile",
        data: { profile: { active: true }, tags: ["alpha", "beta"] },
        createdAt: Date.now(),
      } as Component,
      {
        id: uuidv4() as UUID,
        entityId: entityOne,
        agentId,
        roomId: roomTwo,
        worldId: worldTwo,
        sourceEntityId: entityOne,
        type: "secondary",
        data: { enabled: true },
        createdAt: Date.now(),
      } as Component,
      {
        id: uuidv4() as UUID,
        entityId: entityTwo,
        agentId,
        roomId: roomOne,
        worldId: worldOne,
        sourceEntityId: entityOne,
        type: "profile",
        data: { profile: { active: false }, tags: ["alpha"] },
        createdAt: Date.now(),
      } as Component,
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it.each([
    ["offset", -1],
    ["offset", 1.5],
    ["limit", Number.NaN],
    ["limit", Number.POSITIVE_INFINITY],
  ] as const)("rejects invalid %s pagination value %s", async (field, value) => {
    await expect(adapter.queryEntities({ entityIds: [entityOne], [field]: value })).rejects.toThrow(
      `queryEntities ${field} must be a non-negative safe integer`
    );
  });

  it("intersects explicit IDs with component, data, world, agent, and paging filters", async () => {
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

  it("serves every entity exactly once when paging across an update", async () => {
    const paged = Array.from({ length: 4 }, () => uuidv4() as UUID);
    await adapter.createEntities(
      paged.map((id): Entity => ({ id, agentId, names: [`paged-${id}`] }))
    );
    const all = (await adapter.queryEntities({ agentId })).map((e) => e.id as UUID);
    const served: UUID[] = [];
    for (let offset = 0; ; offset += 1) {
      const [entity] = await adapter.queryEntities({ agentId, limit: 1, offset });
      if (!entity) break;
      served.push(entity.id as UUID);
      if (offset === 0) {
        // Rewrites the first row's physical position mid-scan.
        await adapter.updateEntity({ ...entity, names: ["renamed"] });
      }
    }

    // Every entity exactly once: catches a skip as well as a duplicate.
    expect([...served].sort()).toEqual([...all].sort());
    expect(all).toEqual(expect.arrayContaining(paged));
  });

  it("keeps the page order across a read-modify-write of a microsecond created_at", async () => {
    const before = (await adapter.queryEntities({ agentId })).map((e) => e.id as UUID);
    const batch = Array.from({ length: 4 }, () => uuidv4() as UUID);
    await adapter.createEntities(
      batch.map((id): Entity => ({ id, agentId, names: [`precise-${id}`] }))
    );
    // PostgreSQL's now() carries microseconds; PGlite's clock does not, so set
    // them explicitly. Reads hand created_at back as a millisecond Date.
    await (adapter.getDatabase() as DrizzleDatabase)
      .update(entityTable)
      .set({
        createdAt: sql`date_trunc('milliseconds', ${entityTable.createdAt}) + interval '456 microseconds'`,
      })
      .where(inArray(entityTable.id, batch));
    const order = (await adapter.queryEntities({ agentId })).map((e) => e.id as UUID);
    const batchOrder = order.filter((id) => batch.includes(id));
    const firstOfBatch = batchOrder[0];
    const lastOfBatch = batchOrder[batchOrder.length - 1];

    const served: UUID[] = [];
    for (let offset = 0; ; offset += 1) {
      const [entity] = await adapter.queryEntities({ agentId, limit: 1, offset });
      if (!entity) break;
      served.push(entity.id as UUID);
      if (entity.id === firstOfBatch) {
        // An ordinary caller update of a row the scan has not reached yet.
        const [unserved] = await adapter.getEntitiesByIds([lastOfBatch]);
        if (!unserved) throw new Error("seeded entity missing");
        await adapter.updateEntity({ ...unserved, names: ["renamed"] });
      }
    }

    expect([...served].sort()).toEqual([...before, ...batch].sort());
  });

  it("serves an entity inserted mid-scan after the rows already paged", async () => {
    const served: UUID[] = [];
    // The smallest possible id: an id-only order would put it first and shift
    // every remaining page by one.
    const inserted = "00000000-0000-4000-8000-000000000000" as UUID;
    const before = (await adapter.queryEntities({ agentId })).map((e) => e.id as UUID);
    for (let offset = 0; ; offset += 1) {
      const [entity] = await adapter.queryEntities({ agentId, limit: 1, offset });
      if (!entity) break;
      served.push(entity.id as UUID);
      if (offset === 1) {
        await adapter.createEntities([{ id: inserted, agentId, names: ["late"] }]);
      }
    }

    expect([...served].sort()).toEqual([...before, inserted].sort());
  });
});
