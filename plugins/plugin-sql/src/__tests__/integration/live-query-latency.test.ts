import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

/**
 * Integration tests for the PGlite live query latency.
 *
 * The SSE endpoint at /api/database/status/events and the WebSocket
 * endpoint at ws://host:PORT/api/database/status/events both use
 * live queries to push reactive table counts. These tests exercise
 * the same `live.query()` pipeline directly, measuring end-to-end
 * latency from INSERT to callback fire.
 *
 * Note: we use `live.query()` (not `incrementalQuery`) because the
 * production pipeline uses a UNION ALL query with a `table_name` key
 * column to identify rows, while these single-table tests use simple
 * COUNT(*) aggregates without a stable row identifier.
 */

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Live query latency", () => {
  const cleanups: Array<{ dir: string; manager?: PGliteClientManager }> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      if (c.manager) {
        try {
          await c.manager.close();
        } catch {}
      }
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ------------------------------------------------------------------
  // Helper: create manager, run migrations, return db handle
  // ------------------------------------------------------------------
  async function setupPGlite(): Promise<{
    manager: PGliteClientManager;
    db: DrizzleDatabase;
    agentId: string;
  }> {
    const dir = createTempDir("eliza-live-latency-");
    const agentId = v4();

    const manager = new PGliteClientManager({
      dataDir: dir,
      agentId,
    });
    await manager.initialize();
    cleanups.push({ dir, manager });

    const client = manager.getConnection();
    const { drizzle } = await import("drizzle-orm/pglite");
    const db = drizzle(client) as unknown as DrizzleDatabase;

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();

    // Create agent + room rows (FK requirements for memories).
    const now = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO agents (id, name, created_at, updated_at) VALUES ('${agentId}', 'latency-test', to_timestamp(${now / 1000.0}), to_timestamp(${now / 1000.0}))`
      )
    );
    const roomId = v4();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'test-room', 'test', 'GROUP', to_timestamp(${now / 1000.0}))`
      )
    );

    return { manager, db, agentId };
  }

  // ------------------------------------------------------------------
  // 1. live.query() fires within 100ms of INSERT
  // ------------------------------------------------------------------
  it("live.query() callback fires within 100ms of a table INSERT", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return; // Extensions disabled

    const memoryId = v4();
    const roomId = v4();

    // Create a fresh room for this test's memories.
    const now = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'test-room', 'test', 'GROUP', to_timestamp(${now / 1000.0}))`
      )
    );

    // Set up a promise that resolves on the second callback (after INSERT).
    const countUpdated = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Live query did not fire within 5s")),
        5000
      );

      let initialFired = false;
      let unsubscribe: (() => Promise<void>) | null = null;

      liveNs
        .query<{ count: string | number }>(
          "SELECT COUNT(*)::text AS count FROM memories",
          [],
          (result) => {
            const count = parseInt(String(result.rows[0]?.count ?? "0"), 10);
            if (!initialFired) {
              initialFired = true;
              return;
            }
            clearTimeout(timeout);
            if (unsubscribe) unsubscribe().catch(() => {});
            resolve(count);
          }
        )
        .then((ret) => {
          unsubscribe = ret.unsubscribe;
        })
        .catch(reject);
    });

    // Wait for initial callback to settle.
    await new Promise((r) => setTimeout(r, 100));

    const startTime = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO memories (id, type, agent_id, room_id, content, created_at) VALUES ('${memoryId}', 'test', '${agentId}', '${roomId}', '{"text":"latency test"}'::jsonb, to_timestamp(${Date.now() / 1000.0}))`
      )
    );

    const count = await countUpdated;
    const elapsed = Date.now() - startTime;

    expect(count).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(100);
  }, 10_000);

  // ------------------------------------------------------------------
  // 2. Count accurately reflects INSERTs
  // ------------------------------------------------------------------
  it("live query count accurately reflects INSERTs", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();
    const now = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'test-room', 'test', 'GROUP', to_timestamp(${now / 1000.0}))`
      )
    );

    const finalCount = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Live query did not reach expected count within 5s")),
        5000
      );

      let unsubscribe: (() => Promise<void>) | null = null;

      liveNs
        .query<{ count: string | number }>(
          "SELECT COUNT(*)::text AS count FROM memories",
          [],
          (result) => {
            const count = parseInt(String(result.rows[0]?.count ?? "0"), 10);
            if (count >= 3) {
              clearTimeout(timeout);
              if (unsubscribe) unsubscribe().catch(() => {});
              resolve(count);
            }
          }
        )
        .then((ret) => {
          unsubscribe = ret.unsubscribe;
        })
        .catch(reject);
    });

    // Let initial callback settle.
    await new Promise((r) => setTimeout(r, 50));

    for (let i = 0; i < 3; i++) {
      await db.execute(
        sql.raw(
          `INSERT INTO memories (id, type, agent_id, room_id, content, created_at) VALUES ('${v4()}', 'test', '${agentId}', '${roomId}', '{"text":"batch ${i}"}'::jsonb, to_timestamp(${now / 1000.0}))`
        )
      );
      await new Promise((r) => setTimeout(r, 10));
    }

    const count = await finalCount;
    expect(count).toBeGreaterThanOrEqual(3);
  }, 10_000);

  // ------------------------------------------------------------------
  // 3. Rooms table also pushes within 100ms
  // ------------------------------------------------------------------
  it("live.query() fires within 100ms for rooms INSERT too", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();

    const countUpdated = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Live query did not fire within 5s")),
        5000
      );

      let initialFired = false;
      let unsubscribe: (() => Promise<void>) | null = null;

      liveNs
        .query<{ count: string | number }>(
          "SELECT COUNT(*)::text AS count FROM rooms",
          [],
          (result) => {
            const count = parseInt(String(result.rows[0]?.count ?? "0"), 10);
            if (!initialFired) {
              initialFired = true;
              return;
            }
            clearTimeout(timeout);
            if (unsubscribe) unsubscribe().catch(() => {});
            resolve(count);
          }
        )
        .then((ret) => {
          unsubscribe = ret.unsubscribe;
        })
        .catch(reject);
    });

    await new Promise((r) => setTimeout(r, 100));

    const startTime = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'test-room-2', 'test', 'GROUP', to_timestamp(${Date.now() / 1000.0}))`
      )
    );

    const count = await countUpdated;
    const elapsed = Date.now() - startTime;

    expect(count).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(100);
  }, 10_000);
}, 60_000);
