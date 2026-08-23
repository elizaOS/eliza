/**
 * Exercises native message-content publication and bounded reads against a
 * real PGlite database, including a fresh adapter process over the same data
 * directory and authorization revocation after publication.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Agent, buildMessageContentProjection, type Memory, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

describe("PGlite message content segments", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const directory of cleanupPaths.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  async function open(dataDir: string, agentId: UUID, migrate: boolean) {
    const manager = new PGliteClientManager({ dataDir });
    await manager.initialize();
    const adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();
    if (migrate) {
      const migrationService = new DatabaseMigrationService();
      await migrationService.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
      migrationService.discoverAndRegisterPluginSchemas([
        { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
      ]);
      await migrationService.runAllPluginMigrations();
    }
    return adapter;
  }

  it("survives restart and reauthorizes every continuation", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-message-segments-"));
    cleanupPaths.push(dataDir);
    const agentId = uuidv4() as UUID;
    const entityId = uuidv4() as UUID;
    const roomId = uuidv4() as UUID;
    const messageId = uuidv4() as UUID;
    let adapter = await open(dataDir, agentId, true);
    await adapter.createAgent({ id: agentId, name: "Segment agent" } as Agent);
    await adapter.createEntities([{ id: entityId, agentId, names: ["Segment reader"] }]);
    await adapter.createRooms([
      { id: roomId, agentId, source: "test", type: "GROUP", name: "Room" },
    ]);
    await adapter.createRoomParticipants([entityId], roomId);

    const original: Memory & { id: UUID } = {
      id: messageId,
      agentId,
      entityId,
      roomId,
      createdAt: Date.now(),
      content: { text: "🙂 persistent content\n".repeat(50_000) },
      metadata: { type: "message", scope: "room" },
    };
    const projection = buildMessageContentProjection(original);
    await expect(
      adapter.publishMessageContentSegments({
        mode: "create",
        parent: { ...original, content: projection.content },
        segments: projection.segments,
      })
    ).resolves.toMatchObject({ status: "created" });

    const first = await adapter.readMessageContentRange({
      agentId,
      messageId,
      authorizedRoomId: roomId,
      accessContext: { requesterEntityId: entityId, role: "USER" },
      source: { kind: "message-text" },
      offset: 0,
      limit: 32 * 1024,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("expected segmented page");

    await adapter.close();
    adapter = await open(dataDir, agentId, false);
    const continued = await adapter.readMessageContentRange({
      agentId,
      messageId,
      authorizedRoomId: roomId,
      accessContext: { requesterEntityId: entityId, role: "USER" },
      source: { kind: "message-text" },
      offset: first.page.end,
      limit: 32 * 1024,
      expectedRevision: first.page.revision,
    });
    expect(continued.status).toBe("ok");

    await adapter.deleteParticipants([{ entityId, roomId }]);
    await expect(
      adapter.readMessageContentRange({
        agentId,
        messageId,
        authorizedRoomId: roomId,
        accessContext: { requesterEntityId: entityId, role: "USER" },
        source: { kind: "message-text" },
        offset: first.page.end,
        limit: 32 * 1024,
        expectedRevision: first.page.revision,
      })
    ).resolves.toEqual({ status: "forbidden" });
    await adapter.close();
  }, 60_000);
});
