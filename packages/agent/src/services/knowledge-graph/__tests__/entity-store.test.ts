/**
 * Unit tests for EntityStore resolution and confidence sorting.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { Entity } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { EntityStore } from "../entity-store.ts";

describe("EntityStore.resolve confidence sorting", () => {
  it("maintains strict total ordering when entity confidence values contain non-finite numbers", async () => {
    const mockRuntime = {} as IAgentRuntime;
    const store = new EntityStore(mockRuntime, "test-agent");

    const entity1: Entity = {
      entityId: "ent-1",
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const entity2: Entity = {
      entityId: "ent-2",
      type: "person",
      preferredName: "Alice Smith",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const entity3: Entity = {
      entityId: "ent-3",
      type: "person",
      preferredName: "",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    vi.spyOn(store, "list").mockResolvedValue([entity3, entity1, entity2]);

    const candidates = await store.resolve({ name: "Alice" });

    expect(candidates).toHaveLength(3);
    // Exact name match yields confidence 0.9
    expect(candidates[0]?.entity.entityId).toBe("ent-1");
    expect(candidates[0]?.confidence).toBe(0.9);
    // Non-exact name match yields confidence 0.55
    expect(candidates[1]?.entity.entityId).toBe("ent-2");
    expect(candidates[1]?.confidence).toBe(0.55);
    // No name match yields confidence 0
    expect(candidates[2]?.entity.entityId).toBe("ent-3");
    expect(candidates[2]?.confidence).toBe(0);
  });
});
