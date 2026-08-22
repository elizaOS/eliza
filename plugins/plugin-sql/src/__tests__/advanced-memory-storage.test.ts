/**
 * Exercises long-term-memory access timestamp updates through the real runtime,
 * migrated PGlite adapter, and AdvancedMemoryStorageService persistence path.
 */
import type { Entity, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvancedMemoryStorageService } from "../services/advanced-memory-storage";
import { createTestDatabase } from "./test-helpers";

describe("AdvancedMemoryStorageService.updateLongTermMemory", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("retains the persisted access timestamp when an unrelated field is updated", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const lastAccessedAt = new Date("2026-08-02T15:30:00.000Z");

    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
    });

    await service.updateLongTermMemory(stored.id, agentId, entityId, { lastAccessedAt });
    await service.updateLongTermMemory(stored.id, agentId, entityId, {
      content: "Updated memory",
    });

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.content).toBe("Updated memory");
    expect(updated?.lastAccessedAt?.toISOString()).toBe(lastAccessedAt.toISOString());
  });

  it("persists an access timestamp supplied while storing the memory", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const lastAccessedAt = new Date("2026-08-04T12:00:00.000Z");

    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
      lastAccessedAt,
    });

    expect(stored.lastAccessedAt?.toISOString()).toBe(lastAccessedAt.toISOString());
    const [persisted] = await service.getLongTermMemories(agentId, entityId);
    expect(persisted?.lastAccessedAt?.toISOString()).toBe(lastAccessedAt.toISOString());
  });

  it("names the long-term room with the complete entity UUID", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const ensureRoomExists = vi.spyOn(runtime, "ensureRoomExists");

    await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Remember the complete room identity",
    });

    expect(ensureRoomExists).toHaveBeenCalledWith(
      expect.objectContaining({ name: `Advanced Memory ${entityId}` })
    );
  });

  it("replaces the creation access timestamp with an explicit older value", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const initial = new Date("2026-08-03T09:45:00.000Z");
    const replacement = new Date("2026-08-02T15:30:00.000Z");

    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
      lastAccessedAt: initial,
    });
    expect(stored.lastAccessedAt?.toISOString()).toBe(initial.toISOString());

    await service.updateLongTermMemory(stored.id, agentId, entityId, {
      lastAccessedAt: replacement,
    });

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.lastAccessedAt?.toISOString()).toBe(replacement.toISOString());
  });

  it("serializes concurrent partial updates so a stale snapshot cannot replace newer metadata", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const initial = new Date("2026-08-03T09:45:00.000Z");
    const replacement = new Date("2026-08-02T15:30:00.000Z");
    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
      lastAccessedAt: initial,
    });

    let firstUpdateStarted!: () => void;
    const firstUpdate = new Promise<void>((resolve) => {
      firstUpdateStarted = resolve;
    });
    let releaseFirstUpdate!: () => void;
    const firstUpdateRelease = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const originalUpdateMemory = runtime.updateMemory.bind(runtime);
    const updateMemory = vi.spyOn(runtime, "updateMemory").mockImplementation(async (memory) => {
      firstUpdateStarted();
      await firstUpdateRelease;
      await originalUpdateMemory(memory);
    });

    const contentUpdate = service.updateLongTermMemory(stored.id, agentId, entityId, {
      content: "Updated memory",
    });
    await firstUpdate;
    const explicitUpdate = service.updateLongTermMemory(stored.id, agentId, entityId, {
      lastAccessedAt: replacement,
    });
    releaseFirstUpdate();
    await Promise.all([contentUpdate, explicitUpdate]);
    updateMemory.mockRestore();

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.content).toBe("Updated memory");
    expect(updated?.lastAccessedAt?.toISOString()).toBe(replacement.toISOString());
  });

  it("applies the explicit access timestamp from each serialized update", async () => {
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const { runtime, cleanup } = await createTestDatabase(agentId);
    cleanups.push(cleanup);
    await runtime.createEntities([
      { id: entityId, agentId, names: ["Test Entity"], metadata: {} } as Entity,
    ]);
    const service = new AdvancedMemoryStorageService();
    await service.initialize(runtime);
    const older = new Date("2026-08-02T15:30:00.000Z");
    const newer = new Date("2026-08-03T09:45:00.000Z");
    const stored = await service.storeLongTermMemory({
      agentId,
      entityId,
      category: "semantic",
      content: "Original memory",
    });

    await Promise.all([
      service.updateLongTermMemory(stored.id, agentId, entityId, {
        lastAccessedAt: newer,
      }),
      service.updateLongTermMemory(stored.id, agentId, entityId, {
        lastAccessedAt: older,
      }),
    ]);

    const [updated] = await service.getLongTermMemories(agentId, entityId);
    expect(updated?.lastAccessedAt?.toISOString()).toBe(older.toISOString());
  });
});
