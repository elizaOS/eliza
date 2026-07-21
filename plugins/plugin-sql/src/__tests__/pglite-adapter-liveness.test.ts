/**
 * Focused unit coverage for the PGlite adapter's liveness probe and write-back
 * wrapper contract. The base persistence methods are stubbed at the superclass
 * boundary so this test exercises adapter behavior without requiring migrated
 * SQL tables.
 */

import type { UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseDrizzleAdapter } from "../base";
import { PgliteDatabaseAdapter } from "../pglite/adapter";

const agentId = "00000000-0000-4000-8000-000000000001" as UUID;
const entityId = "00000000-0000-4000-8000-000000000002" as UUID;
const roomId = "00000000-0000-4000-8000-000000000003" as UUID;
const worldId = "00000000-0000-4000-8000-000000000004" as UUID;
const memoryId = "00000000-0000-4000-8000-000000000005" as UUID;
const relationshipId = "00000000-0000-4000-8000-000000000006" as UUID;
const taskId = "00000000-0000-4000-8000-000000000007" as UUID;

function makeAdapter() {
  const rawConnection = {
    query: vi.fn(async (query: string) => {
      if (query.includes("participants")) {
        return { rows: [{ id: "participant-row" }] };
      }
      if (query.includes("relationships")) {
        return { rows: [{ id: relationshipId }] };
      }
      if (query.includes("memories")) {
        return { rows: [{ id: memoryId }] };
      }
      return { rows: [] };
    }),
  };
  const manager = {
    close: vi.fn(async () => undefined),
    ensureSync: vi.fn(async () => undefined),
    getConnection: vi.fn(() => rawConnection),
    initialize: vi.fn(async () => undefined),
    isInitialized: vi.fn(() => true),
    isShuttingDown: vi.fn(() => false),
    notifyWrite: vi.fn(),
  };
  const adapter = new PgliteDatabaseAdapter(agentId, manager as never);
  const db = {
    execute: vi.fn(async () => [{ "?column?": 1 }]),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  (adapter as unknown as { db: typeof db }).db = db;
  return { adapter, db, manager, rawConnection };
}

describe("PgliteDatabaseAdapter liveness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a real SELECT probe and fails closed when the handle is closed", async () => {
    const { adapter, db, manager } = makeAdapter();

    await expect(adapter.isReady()).resolves.toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(1);

    db.execute.mockRejectedValueOnce(new Error("PGlite is closed"));
    await expect(adapter.isReady()).resolves.toBe(false);

    manager.isShuttingDown.mockReturnValueOnce(true);
    await expect(adapter.isReady()).resolves.toBe(false);

    manager.isInitialized.mockReturnValueOnce(false);
    await expect(adapter.isReady()).resolves.toBe(false);
  });

  it("keeps initialization, transaction, connection, close, and shutdown rejection semantics", async () => {
    const { adapter, db, manager, rawConnection } = makeAdapter();

    await expect(adapter.init()).resolves.toBeUndefined();
    await expect(adapter.getConnection()).resolves.toBe(db);
    expect(adapter.getRawConnection()).toBe(rawConnection);
    await expect(
      adapter.withEntityContext(null, async (tx) => {
        expect(tx).toBe(db);
        return "ok";
      })
    ).resolves.toBe("ok");
    await expect(
      (
        adapter as unknown as {
          withDatabase: <T>(operation: () => Promise<T>) => Promise<T>;
        }
      ).withDatabase(async () => "ready")
    ).resolves.toBe("ready");

    manager.isShuttingDown.mockReturnValueOnce(true);
    await expect(
      (
        adapter as unknown as {
          withDatabase: <T>(operation: () => Promise<T>) => Promise<T>;
        }
      ).withDatabase(async () => "never")
    ).rejects.toThrow("Database is shutting down - operation rejected");

    await adapter.close();
    expect(manager.close).toHaveBeenCalledTimes(1);
  });

  it("emits write-back records for successful adapter writes only", async () => {
    const { adapter, manager } = makeAdapter();
    vi.spyOn(BaseDrizzleAdapter.prototype, "createAgent").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateAgent").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteAgent").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteAgents").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "createEntities").mockResolvedValue([entityId]);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateEntity").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteEntity").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "createWorld").mockResolvedValue(worldId);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateWorld").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "removeWorld").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "createRooms").mockResolvedValue([roomId]);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateRoom").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteRoom").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "addParticipant").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "removeParticipant").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "createMemory").mockResolvedValue(memoryId);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateMemory").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteMemory").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteManyMemories").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteAllMemories").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "createRelationship").mockResolvedValue(true);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateRelationship").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteRelationships").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "createTask").mockResolvedValue(taskId);
    vi.spyOn(BaseDrizzleAdapter.prototype, "updateTask").mockResolvedValue();
    vi.spyOn(BaseDrizzleAdapter.prototype, "deleteTask").mockResolvedValue();

    await adapter.createAgent({ id: agentId, name: "Agent" });
    await adapter.updateAgent(agentId, { name: "Updated" });
    await adapter.deleteAgent(agentId);
    await adapter.deleteAgents([agentId]);
    await adapter.createEntities([{ id: entityId, names: ["Entity"], agentId }]);
    await adapter.updateEntity({ id: entityId, names: ["Entity"], agentId });
    await adapter.deleteEntity(entityId);
    await adapter.createWorld({ id: worldId, name: "World", agentId });
    await adapter.updateWorld({ id: worldId, name: "World", agentId });
    await adapter.removeWorld(worldId);
    await adapter.createRooms([{ id: roomId, name: "Room", agentId }]);
    await adapter.updateRoom({ id: roomId, name: "Room", agentId });
    await adapter.deleteRoom(roomId);
    await adapter.addParticipant(entityId, roomId);
    await adapter.removeParticipant(entityId, roomId);
    await adapter.createMemory(
      { id: memoryId, entityId, roomId, agentId, content: { text: "hi" } },
      "messages"
    );
    await adapter.updateMemory({ id: memoryId, content: { text: "bye" } });
    await adapter.deleteMemory(memoryId);
    await adapter.deleteManyMemories([memoryId]);
    await adapter.deleteAllMemories([roomId], "messages");
    await adapter.createRelationship({ sourceEntityId: entityId, targetEntityId: agentId });
    await adapter.updateRelationship({
      id: relationshipId,
      sourceEntityId: entityId,
      targetEntityId: agentId,
      agentId,
    });
    await adapter.deleteRelationships([relationshipId]);
    await adapter.createTask({ id: taskId, name: "Task", agentId });
    await adapter.updateTask(taskId, { name: "Updated task" });
    await adapter.deleteTask(taskId);

    expect(manager.notifyWrite.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      expect.arrayContaining([
        ["agents", "insert"],
        ["agents", "upsert"],
        ["agents", "delete"],
        ["entities", "insert"],
        ["worlds", "insert"],
        ["rooms", "insert"],
        ["participants", "insert"],
        ["memories", "insert"],
        ["relationships", "insert"],
        ["tasks", "insert"],
      ])
    );
  });
});
