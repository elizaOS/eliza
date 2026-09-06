/**
 * Adversarial probe for the #25140 accessContext page reauthorization
 * (deterministic, real PGlite; RED control: fails without commit c58207e7c4).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import type { DrizzleDatabase } from "../../types";

const tempDirectories: string[] = [];

async function openDatabase(dataDir: string, agentId: UUID) {
  const manager = new PGliteClientManager({ dataDir });
  await manager.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  await adapter.init();
  return { adapter, manager };
}

async function migrate(adapter: PgliteDatabaseAdapter) {
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
}

function largeSource(byteLength: number): string {
  const unit = "segurança שלום 🌏 test ";
  const chunks: string[] = [];
  let bytes = 0;
  while (bytes < byteLength) {
    chunks.push(unit);
    bytes += Buffer.byteLength(unit, "utf8");
  }
  return chunks.join("");
}

async function seedRoom(adapter: PgliteDatabaseAdapter, agentId: UUID) {
  const entityId = v4() as UUID;
  const roomId = v4() as UUID;
  await adapter.createAgent({
    id: agentId,
    name: "accessCtx probe",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      name: "accessCtx room",
      source: "test",
      type: "direct" as never,
      worldId: undefined,
      channelId: undefined,
    },
  ]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["user"] }]);
  return { roomId, entityId };
}

describe("accessContext page reauthorization (real PGlite)", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("denies pages to an access context whose room is not authorized, grants the right room", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-accctx-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: { text: largeSource(150 * 1024), source: "test" },
      } as unknown as Memory,
      "messages"
    );

    // Authorized: same room, requester carries a real role.
    const allowed = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      accessContext: {
        agentId,
        roomId,
        authorizedRoomIds: [roomId],
        requesterEntityId: entityId,
        role: "USER",
      } as never,
    });
    expect(allowed).not.toBeNull();
    expect(allowed?.revision).toBeTruthy();

    // Denied: the parent lives in a room this context is not authorized for.
    const otherRoom = v4() as UUID;
    const denied = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      accessContext: {
        agentId,
        roomId: otherRoom,
        authorizedRoomIds: [otherRoom],
        requesterEntityId: entityId,
        role: "USER",
      } as never,
    });
    expect(denied).toBeNull();

    // Denied: unresolved actor (no role authority -> UNRESOLVED -> false).
    const unresolved = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      accessContext: {
        agentId,
        roomId,
        authorizedRoomIds: [roomId],
        requesterEntityId: entityId,
      } as never,
    });
    expect(unresolved).toBeNull();

    await adapter.close();
    await manager.close();
  });
});
