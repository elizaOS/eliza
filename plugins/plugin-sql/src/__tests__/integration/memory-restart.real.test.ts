/**
 * Real PGlite restart coverage for durable memory lifecycle behavior.
 * The test closes every database object, opens the same on-disk database through
 * a fresh manager and adapter, then verifies read, update, and delete behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChannelType,
  type Entity,
  type Memory,
  MemoryType,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
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

describe("durable memory restart lifecycle", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recalls, updates, and forgets a fact through fresh database processes", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-memory-restart-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const ownerId = v4() as UUID;
    const worldId = v4() as UUID;
    const serverId = v4() as UUID;
    const roomId = v4() as UUID;
    const memoryId = v4() as UUID;

    const first = await openDatabase(dataDir, agentId);
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(first.adapter.getDatabase() as DrizzleDatabase);
    migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrations.runAllPluginMigrations();
    await first.adapter.createAgent({
      id: agentId,
      name: "Memory restart evaluator",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await first.adapter.createWorld({
      id: worldId,
      agentId,
      name: "Private owner world",
      serverId,
    } satisfies World);
    await first.adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "Owner DM",
        source: "test",
        type: ChannelType.DM,
      } satisfies Room,
    ]);
    await first.adapter.createEntities([
      {
        id: ownerId,
        agentId,
        names: ["Owner"],
      } satisfies Entity,
    ]);
    await first.adapter.addParticipant(ownerId, roomId);
    await first.adapter.createMemory(
      {
        id: memoryId,
        agentId,
        entityId: ownerId,
        roomId,
        content: {
          text: "The durable restart codename is Kingfisher.",
          source: "memory-restart-eval",
        },
        metadata: {
          type: MemoryType.CUSTOM,
          source: "memory-restart-eval",
        },
        createdAt: Date.now(),
        unique: false,
      } satisfies Memory,
      "facts"
    );
    await first.adapter.close();

    const second = await openDatabase(dataDir, agentId);
    const afterRestart = await second.adapter.getMemoryById(memoryId);
    expect(afterRestart?.content.text).toBe("The durable restart codename is Kingfisher.");
    await second.adapter.updateMemories([
      {
        id: memoryId,
        content: {
          text: "The durable restart codename is Nightjar.",
          source: "memory-restart-eval",
        },
      },
    ]);
    await second.adapter.close();

    const third = await openDatabase(dataDir, agentId);
    expect((await third.adapter.getMemoryById(memoryId))?.content.text).toBe(
      "The durable restart codename is Nightjar."
    );
    await third.adapter.deleteMemory(memoryId);
    await third.adapter.close();

    const fourth = await openDatabase(dataDir, agentId);
    expect(await fourth.adapter.getMemoryById(memoryId)).toBeNull();
    await fourth.adapter.close();
  });
});
