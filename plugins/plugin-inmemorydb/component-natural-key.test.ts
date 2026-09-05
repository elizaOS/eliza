/** Exercises component natural-key upsert/lookup through the real Map-backed adapter, proving that a component stored without a worldId/sourceEntityId is still returned by getComponentsByNaturalKeys (the runtime.getComponent path passes undefined for both). */

import type { Component, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const entityId = "10000000-0000-0000-0000-000000000001" as UUID;
const roomId = "20000000-0000-0000-0000-000000000002" as UUID;
const worldId = "30000000-0000-0000-0000-000000000003" as UUID;
const otherWorldId = "30000000-0000-0000-0000-000000000009" as UUID;

function makeComponent(overrides: Partial<Component> = {}): Component {
  return {
    id: "40000000-0000-0000-0000-000000000001" as UUID,
    entityId,
    agentId,
    roomId,
    type: "profile",
    data: {},
    createdAt: 1,
    ...overrides,
  } as Component;
}

describe("plugin-inmemorydb component natural-key round-trip", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("returns a component upserted without worldId/sourceEntityId (the runtime.getComponent path)", async () => {
    await adapter.upsertComponents([makeComponent({ data: { foo: "bar" } })]);

    // Runtime.getComponent(entityId, type) omits worldId/sourceEntityId → undefined.
    const found = await adapter.getComponentsByNaturalKeys([{ entityId, type: "profile" }]);

    expect(found).toHaveLength(1);
    expect(found[0]).not.toBeNull();
    expect(found[0]?.id).toBe("40000000-0000-0000-0000-000000000001");
    expect(found[0]?.data).toEqual({ foo: "bar" });
  });

  it("matches on explicit worldId and rejects a different worldId", async () => {
    await adapter.upsertComponents([makeComponent({ worldId, data: { scope: "world" } })]);

    const matched = await adapter.getComponentsByNaturalKeys([
      { entityId, type: "profile", worldId },
    ]);
    expect(matched[0]).not.toBeNull();
    expect(matched[0]?.data).toEqual({ scope: "world" });

    const mismatched = await adapter.getComponentsByNaturalKeys([
      { entityId, type: "profile", worldId: otherWorldId },
    ]);
    expect(mismatched[0]).toBeNull();

    // A worldless component is distinct from the world-scoped one and must not match.
    const worldless = await adapter.getComponentsByNaturalKeys([{ entityId, type: "profile" }]);
    expect(worldless[0]).toBeNull();
  });

  it("treats undefined and null worldId/sourceEntityId as the same natural key on both sides", async () => {
    await adapter.upsertComponents([makeComponent({ data: { via: "undefined" } })]);

    // Query side supplies explicit null where the stored side is undefined.
    const nullQuery = await adapter.getComponentsByNaturalKeys([
      {
        entityId,
        type: "profile",
        worldId: null as unknown as UUID,
        sourceEntityId: null as unknown as UUID,
      },
    ]);
    expect(nullQuery[0]).not.toBeNull();
    expect(nullQuery[0]?.data).toEqual({ via: "undefined" });
  });

  it("upserts the same natural key in place, keeping one component with the latest data", async () => {
    await adapter.upsertComponents([makeComponent({ data: { rev: 1 } })]);
    await adapter.upsertComponents([
      makeComponent({ id: "40000000-0000-0000-0000-0000000000ff" as UUID, data: { rev: 2 } }),
    ]);

    const forEntity = await adapter.getComponentsForEntities([entityId]);
    expect(forEntity).toHaveLength(1);
    expect(forEntity[0]?.data).toEqual({ rev: 2 });

    const byKey = await adapter.getComponentsByNaturalKeys([{ entityId, type: "profile" }]);
    expect(byKey[0]).not.toBeNull();
    expect(byKey[0]?.data).toEqual({ rev: 2 });
    // Dedup keeps the original id even though the second upsert supplied a new one.
    expect(byKey[0]?.id).toBe("40000000-0000-0000-0000-000000000001");
  });
});
