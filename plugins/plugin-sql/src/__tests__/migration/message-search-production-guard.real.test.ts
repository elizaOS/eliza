/**
 * Real-PGlite migration tests for the production guard around message-search
 * DDL. The guard is environment-driven because the migration service only sees
 * a Drizzle handle, not the adapter/manager that selected Postgres vs PGlite.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
  type Agent,
  ChannelType,
  type Entity,
  type Memory,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { v4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import type { DrizzleDatabase } from "../../types";
import { mockCharacter } from "../schema-data";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

describe("message-search production DDL guard", () => {
  let pgClient: PGlite;
  let db: DrizzleDatabase;
  let originalNodeEnv: string | undefined;
  let originalApplyMessageSearchObjects: string | undefined;

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalApplyMessageSearchObjects = process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    pgClient = new PGlite({ extensions: { vector } });
    db = drizzle(pgClient);
  });

  afterEach(async () => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalApplyMessageSearchObjects === undefined) {
      delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;
    } else {
      process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS = originalApplyMessageSearchObjects;
    }

    await pgClient.close();
  });

  const runSqlPluginMigration = async (databaseBackend: "postgres" | "pglite", targetDb = db) => {
    const migrationService = new DatabaseMigrationService({ databaseBackend });
    await migrationService.initializeWithDatabase(targetDb);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations();
  };

  const messageSearchColumnExists = async (targetDb = db): Promise<boolean> => {
    const result = await targetDb.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'memories'
        AND column_name = 'message_search_document'
    `);
    return result.rows.length > 0;
  };

  it("skips generated-column/index DDL by default for production Postgres startup", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    await runSqlPluginMigration("postgres");

    expect(await messageSearchColumnExists()).toBe(false);
  });

  it("applies generated-column/index DDL in production Postgres only when explicitly enabled", async () => {
    process.env.NODE_ENV = "production";
    process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS = "true";

    await runSqlPluginMigration("postgres");

    expect(await messageSearchColumnExists()).toBe(true);
  });

  it("keeps automatic install enabled for embedded PGlite production builds", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    await runSqlPluginMigration("pglite");

    expect(await messageSearchColumnExists()).toBe(true);
  });

  it("falls back at runtime when production Postgres startup skipped message-search DDL", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    const setup = await createIsolatedTestDatabaseForMigration("message_search_runtime_fallback");
    try {
      await runSqlPluginMigration("postgres", setup.db);
      expect(await messageSearchColumnExists(setup.db)).toBe(false);

      const { adapter, testAgentId } = setup;
      const now = Date.now();
      expect(
        await adapter.createAgent({
          ...mockCharacter,
          id: testAgentId,
          createdAt: now,
          updatedAt: now,
        } as Agent)
      ).toBe(true);

      const worldId = v4() as UUID;
      const entityId = v4() as UUID;
      const roomId = v4() as UUID;
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        name: "Runtime fallback world",
        serverId: v4(),
      } as World);
      await adapter.createEntities([
        { id: entityId, agentId: testAgentId, names: ["Runtime User"] } as Entity,
      ]);
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          worldId,
          name: "Runtime fallback room",
          source: "test",
          type: ChannelType.DM,
        } as Room,
      ]);
      await adapter.addParticipant(entityId, roomId);

      const seedMessage = async (
        text: string,
        createdAt: number,
        attachments?: Array<{ title: string; url: string }>
      ) => {
        await adapter.createMemory(
          {
            id: v4() as UUID,
            entityId,
            agentId: testAgentId,
            roomId,
            worldId,
            content: attachments ? { text, attachments } : { text },
            metadata: { type: "messages" },
            createdAt,
          } as Memory,
          "messages"
        );
      };

      await seedMessage("runtime fallback recalls alpha-sentinel text", now);
      await seedMessage("attachment carrier for production fallback", now + 1_000, [
        {
          title: "incident-runbook-14230.pdf",
          url: "https://cdn.example.test/incident-runbook-14230.pdf",
        },
      ]);

      const textHits = await adapter.searchMessages({
        roomIds: [roomId],
        query: "alpha-sentinel",
        tableName: "messages",
        limit: 10,
      });
      expect(textHits.map((hit) => (hit.memory.content as { text?: string }).text)).toContain(
        "runtime fallback recalls alpha-sentinel text"
      );
      expect(textHits.every((hit) => hit.ftsRank === 0 && hit.trigramSimilarity === 0)).toBe(true);

      const attachmentHits = await adapter.searchMessages({
        roomIds: [roomId],
        query: "incident-runbook-14230",
        tableName: "messages",
        limit: 10,
      });
      expect(attachmentHits.map((hit) => (hit.memory.content as { text?: string }).text)).toContain(
        "attachment carrier for production fallback"
      );
      expect(attachmentHits.every((hit) => hit.ftsRank === 0 && hit.trigramSimilarity === 0)).toBe(
        true
      );
    } finally {
      await setup.cleanup();
    }
  });
});
