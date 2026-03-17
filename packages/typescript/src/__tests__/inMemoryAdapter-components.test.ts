import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import type { Component, UUID } from "../types";

function uuid(): UUID {
  return crypto.randomUUID() as UUID;
}

function makeComponent(overrides: Partial<Component> = {}): Component {
  return {
    id: uuid(),
    entityId: uuid(),
    agentId: uuid(),
    roomId: uuid(),
    type: "test",
    data: {},
    createdAt: Date.now(),
    ...overrides,
  } as Component;
}

describe("InMemoryDatabaseAdapter — components", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter();
    await adapter.init();
  });

  // ─── createComponents / getComponentsByIds ───

  it("creates and retrieves components by ID", async () => {
    const c1 = makeComponent();
    const c2 = makeComponent();
    const ids = await adapter.createComponents([c1, c2]);
    expect(ids).toEqual([c1.id, c2.id]);

    const fetched = await adapter.getComponentsByIds([c1.id, c2.id]);
    expect(fetched).toHaveLength(2);
    expect(fetched[0].id).toBe(c1.id);
    expect(fetched[1].id).toBe(c2.id);
  });

  it("getComponentsByIds ignores unknown IDs", async () => {
    const c = makeComponent();
    await adapter.createComponents([c]);
    const fetched = await adapter.getComponentsByIds([c.id, uuid()]);
    expect(fetched).toHaveLength(1);
  });

  it("sets createdAt to Date.now() when missing", async () => {
    const c = makeComponent({ createdAt: undefined as unknown as number });
    const before = Date.now();
    await adapter.createComponents([c]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect(typeof fetched.createdAt).toBe("number");
    expect(fetched.createdAt).toBeGreaterThanOrEqual(before);
  });

  // ─── getComponent (single-item, filtered) ───

  it("getComponent filters by entityId + type", async () => {
    const entityId = uuid();
    const c1 = makeComponent({ entityId, type: "profile" });
    const c2 = makeComponent({ entityId, type: "settings" });
    const c3 = makeComponent({ type: "profile" }); // different entity
    await adapter.createComponents([c1, c2, c3]);

    const found = await adapter.getComponent(entityId, "profile");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(c1.id);

    const notFound = await adapter.getComponent(entityId, "nonexistent");
    expect(notFound).toBeNull();
  });

  it("getComponent filters by optional worldId", async () => {
    const entityId = uuid();
    const worldA = uuid();
    const worldB = uuid();
    const c1 = makeComponent({ entityId, type: "x", worldId: worldA });
    const c2 = makeComponent({ entityId, type: "x", worldId: worldB });
    await adapter.createComponents([c1, c2]);

    const found = await adapter.getComponent(entityId, "x", worldA);
    expect(found!.id).toBe(c1.id);
  });

  it("getComponent filters by optional sourceEntityId", async () => {
    const entityId = uuid();
    const src = uuid();
    const c = makeComponent({ entityId, type: "x", sourceEntityId: src });
    await adapter.createComponents([c]);

    const found = await adapter.getComponent(entityId, "x", undefined, src);
    expect(found!.id).toBe(c.id);

    const miss = await adapter.getComponent(entityId, "x", undefined, uuid());
    expect(miss).toBeNull();
  });

  // ─── getComponents (multi-item, filtered) ───

  it("getComponents returns all components for an entity", async () => {
    const entityId = uuid();
    const c1 = makeComponent({ entityId, type: "a" });
    const c2 = makeComponent({ entityId, type: "b" });
    const c3 = makeComponent(); // different entity
    await adapter.createComponents([c1, c2, c3]);

    const result = await adapter.getComponents(entityId);
    expect(result).toHaveLength(2);
  });

  // ─── updateComponents ───

  it("updateComponents overwrites stored data", async () => {
    const c = makeComponent({ data: { score: 10 } });
    await adapter.createComponents([c]);

    await adapter.updateComponents([{ ...c, data: { score: 99 } }]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect((fetched.data as Record<string, unknown>).score).toBe(99);
  });

  // ─── deleteComponents ───

  it("deleteComponents removes components", async () => {
    const c1 = makeComponent();
    const c2 = makeComponent();
    await adapter.createComponents([c1, c2]);

    await adapter.deleteComponents([c1.id]);
    const remaining = await adapter.getComponentsByIds([c1.id, c2.id]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(c2.id);
  });

  // ─── upsertComponents ───

  it("upsertComponents inserts new components", async () => {
    const c = makeComponent();
    await adapter.upsertComponents([c]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect(fetched.id).toBe(c.id);
  });

  it("upsertComponents merges on natural key conflict", async () => {
    const entityId = uuid();
    const c1 = makeComponent({
      entityId,
      type: "profile",
      data: { name: "old" },
    });
    await adapter.createComponents([c1]);

    const c2 = makeComponent({
      entityId,
      type: "profile",
      data: { name: "new" },
    });
    await adapter.upsertComponents([c2]);

    // Should still have 1 component (upserted, not duplicated)
    const all = await adapter.getComponents(entityId);
    expect(all).toHaveLength(1);
    // Data should be updated
    expect((all[0].data as Record<string, unknown>).name).toBe("new");
    // ID should be preserved from original
    expect(all[0].id).toBe(c1.id);
  });

  it("upsertComponents dedupes within batch by natural key", async () => {
    const entityId = uuid();
    const first = makeComponent({
      entityId,
      type: "x",
      data: { v: 1 },
    });
    const second = makeComponent({
      entityId,
      type: "x",
      data: { v: 2 },
    });
    await adapter.upsertComponents([first, second]);

    const all = await adapter.getComponents(entityId);
    expect(all).toHaveLength(1);
    expect((all[0].data as Record<string, unknown>).v).toBe(2);
  });

  // ─── patchComponent ───

  it("patchComponent set: sets a nested value", async () => {
    const c = makeComponent({ data: { wallet: { balance: 100 } } });
    await adapter.createComponents([c]);

    await adapter.patchComponent(c.id, [
      { op: "set", path: "wallet.balance", value: 200 },
    ]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect(
      (
        fetched.data as Record<string, unknown> & {
          wallet: { balance: number };
        }
      ).wallet.balance,
    ).toBe(200);
  });

  it("patchComponent push: appends to array", async () => {
    const c = makeComponent({ data: { tags: ["a"] } });
    await adapter.createComponents([c]);

    await adapter.patchComponent(c.id, [
      { op: "push", path: "tags", value: "b" },
    ]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect((fetched.data as Record<string, unknown>).tags).toEqual(["a", "b"]);
  });

  it("patchComponent push: creates array if not present", async () => {
    const c = makeComponent({ data: {} });
    await adapter.createComponents([c]);

    await adapter.patchComponent(c.id, [
      { op: "push", path: "items", value: "first" },
    ]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect((fetched.data as Record<string, unknown>).items).toEqual(["first"]);
  });

  it("patchComponent remove: deletes a key", async () => {
    const c = makeComponent({ data: { a: 1, b: 2 } });
    await adapter.createComponents([c]);

    await adapter.patchComponent(c.id, [{ op: "remove", path: "a" }]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect(fetched.data).toEqual({ b: 2 });
  });

  it("patchComponent increment: adds to numeric value", async () => {
    const c = makeComponent({ data: { count: 5 } });
    await adapter.createComponents([c]);

    await adapter.patchComponent(c.id, [
      { op: "increment", path: "count", value: 3 },
    ]);
    const [fetched] = await adapter.getComponentsByIds([c.id]);
    expect((fetched.data as Record<string, unknown>).count).toBe(8);
  });

  it("patchComponent throws on unknown component", async () => {
    await expect(
      adapter.patchComponent(uuid(), [{ op: "set", path: "x", value: 1 }]),
    ).rejects.toThrow("Component not found");
  });

  it("patchComponent throws on invalid path", async () => {
    const c = makeComponent();
    await adapter.createComponents([c]);

    await expect(
      adapter.patchComponent(c.id, [
        { op: "set", path: "foo.bar-baz", value: 1 },
      ]),
    ).rejects.toThrow("Invalid patch path");
  });
});
