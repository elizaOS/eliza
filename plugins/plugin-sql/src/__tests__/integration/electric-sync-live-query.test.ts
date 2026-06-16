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
 * Integration tests for the PGlite live query extension (`pg.live`).
 *
 * Verifies three core behaviors of `liveNs.query()`:
 *  1. Reactive results — callbacks push updated rows after mutations.
 *  2. INSERT / UPDATE / DELETE — each mutation type triggers a callback.
 *  3. Unsubscribe cleanup — after unsubscribe(), no further callbacks fire.
 *
 * Each test creates its own PGlite instance in a temp directory, runs the
 * plugin-sql Drizzle migrations, and then exercises `live.query()` directly
 * on the `PGliteClientManager`.
 */

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("PGlite live query extension", () => {
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
  // Helper: create a fresh PGlite manager, run migrations, seed FK rows
  // ------------------------------------------------------------------
  async function setupPGlite(): Promise<{
    manager: PGliteClientManager;
    db: DrizzleDatabase;
    agentId: string;
  }> {
    const dir = createTempDir("eliza-live-query-");
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

    // Create an agent row (FK requirement for rooms and memories).
    const now = Date.now();
    const nowSec = now / 1000.0;
    await db.execute(
      sql.raw(
        `INSERT INTO agents (id, name, created_at, updated_at) VALUES ('${agentId}', 'live-query-test', to_timestamp(${nowSec}), to_timestamp(${nowSec}))`
      )
    );

    return { manager, db, agentId };
  }

  // ------------------------------------------------------------------
  // 1. liveNs.query() returns reactive results
  // ------------------------------------------------------------------
  it("liveNs.query() returns reactive results after INSERT", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return; // Extensions disabled

    const roomId = v4();
    const now = Date.now() / 1000.0;

    // Create a room row so we can insert memories against it.
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'reactive-room', 'test', 'GROUP', to_timestamp(${now}))`
      )
    );

    // Use a Promise to await the post-INSERT callback deterministically.
    const inserted = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Reactive callback did not fire within 5s")),
        5000
      );

      let initialFired = false;

      liveNs
        .query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM memories WHERE agent_id = $1",
          [agentId],
          (result) => {
            const count = parseInt(result.rows[0]?.count ?? "0", 10);
            if (!initialFired) {
              initialFired = true;
              return;
            }
            clearTimeout(timeout);
            resolve(count);
          }
        )
        .catch(reject);
    });

    // Let initial callback settle.
    await new Promise((r) => setTimeout(r, 100));

    // Insert a memory — should trigger a callback with updated count.
    const memoryId = v4();
    await db.execute(
      sql.raw(
        `INSERT INTO memories (id, type, agent_id, room_id, content, created_at) VALUES ('${memoryId}', 'test', '${agentId}', '${roomId}', '{"text":"reactive"}'::jsonb, to_timestamp(${now}))`
      )
    );

    const count = await inserted;
    expect(count).toBeGreaterThanOrEqual(1);
  }, 10_000);

  // ------------------------------------------------------------------
  // 2. Callback fires on INSERT
  // ------------------------------------------------------------------
  it("live.query() callback fires on INSERT", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();
    const now = Date.now() / 1000.0;
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'insert-room', 'test', 'GROUP', to_timestamp(${now}))`
      )
    );

    // Wait for the callback that fires AFTER the INSERT (skip initial).
    const inserted = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("INSERT callback did not fire within 5s")),
        5000
      );

      let initialFired = false;

      liveNs
        .query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM rooms WHERE agent_id = $1",
          [agentId],
          (result) => {
            const count = parseInt(result.rows[0]?.count ?? "0", 10);
            if (!initialFired) {
              initialFired = true;
              // Initial callback includes the room we already inserted.
              expect(count).toBeGreaterThanOrEqual(1);
              return;
            }
            clearTimeout(timeout);
            resolve(count);
          }
        )
        .catch(reject);
    });

    await new Promise((r) => setTimeout(r, 100));

    // Insert a second room — triggers the post-initial callback.
    const roomId2 = v4();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId2}', '${agentId}', 'insert-room-2', 'test', 'GROUP', to_timestamp(${Date.now() / 1000.0}))`
      )
    );

    const count = await inserted;
    expect(count).toBeGreaterThanOrEqual(2);
  }, 10_000);

  // ------------------------------------------------------------------
  // 3. Callback fires on UPDATE
  // ------------------------------------------------------------------
  it("live.query() callback fires on UPDATE", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();
    const now = Date.now() / 1000.0;
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'before-update', 'test', 'GROUP', to_timestamp(${now}))`
      )
    );

    // Wait for the callback that fires AFTER the UPDATE (skip initial).
    const updated = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("UPDATE callback did not fire within 5s")),
        5000
      );

      let initialFired = false;

      liveNs
        .query<{ name: string }>("SELECT name FROM rooms WHERE id = $1", [roomId], (result) => {
          const name = result.rows[0]?.name ?? "";
          if (!initialFired) {
            initialFired = true;
            expect(name).toBe("before-update");
            return;
          }
          clearTimeout(timeout);
          resolve(name);
        })
        .catch(reject);
    });

    await new Promise((r) => setTimeout(r, 100));

    // Update the room name — triggers the post-initial callback.
    await db.execute(sql.raw(`UPDATE rooms SET name = 'after-update' WHERE id = '${roomId}'`));

    const name = await updated;
    expect(name).toBe("after-update");
  }, 10_000);

  // ------------------------------------------------------------------
  // 4. Callback fires on DELETE
  // ------------------------------------------------------------------
  it("live.query() callback fires on DELETE", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();
    const now = Date.now() / 1000.0;
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'delete-me', 'test', 'GROUP', to_timestamp(${now}))`
      )
    );

    // Wait for the callback AFTER delete (count should drop).
    const deleted = new Promise<{ count: number; initialCount: number }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("DELETE callback did not fire within 5s")),
        5000
      );

      let initialFired = false;
      let capturedInitialCount = 0;

      liveNs
        .query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM rooms WHERE agent_id = $1",
          [agentId],
          (result) => {
            const count = parseInt(result.rows[0]?.count ?? "0", 10);
            if (!initialFired) {
              initialFired = true;
              capturedInitialCount = count;
              expect(count).toBeGreaterThanOrEqual(1);
              return;
            }
            clearTimeout(timeout);
            resolve({ count, initialCount: capturedInitialCount });
          }
        )
        .catch(reject);
    });

    await new Promise((r) => setTimeout(r, 100));

    // Delete the room — triggers the post-initial callback with lower count.
    await db.execute(sql.raw(`DELETE FROM rooms WHERE id = '${roomId}'`));

    const { count, initialCount } = await deleted;
    // Count must be strictly lower after deletion.
    expect(count).toBeLessThan(initialCount);
  }, 10_000);

  // ------------------------------------------------------------------
  // 5. Unsubscribe stops callbacks
  // ------------------------------------------------------------------
  it("unsubscribe() stops live query callbacks", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();
    const now = Date.now() / 1000.0;
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'unsub-room', 'test', 'GROUP', to_timestamp(${now}))`
      )
    );

    let callbackFiredAfterUnsubscribe = false;

    const liveReturn = await liveNs.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM rooms WHERE agent_id = $1",
      [agentId],
      () => {
        callbackFiredAfterUnsubscribe = true;
      }
    );

    // Let initial callback fire.
    await new Promise((r) => setTimeout(r, 100));

    // Reset flag and unsubscribe.
    callbackFiredAfterUnsubscribe = false;
    await liveReturn.unsubscribe();

    // Insert another room — should NOT trigger any more callbacks.
    const roomId2 = v4();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId2}', '${agentId}', 'unsub-room-2', 'test', 'GROUP', to_timestamp(${Date.now() / 1000.0}))`
      )
    );

    // Give ample time for any delayed callback to fire.
    await new Promise((r) => setTimeout(r, 300));

    expect(callbackFiredAfterUnsubscribe).toBe(false);
  }, 10_000);

  // ------------------------------------------------------------------
  // 6. liveNs.query() with parameterized query returns correct rows
  // ------------------------------------------------------------------
  it("liveNs.query() with parameters returns correct initial rows", async () => {
    const { manager, db, agentId } = await setupPGlite();

    const liveNs = manager.liveQuery();
    if (!liveNs) return;

    const roomId = v4();
    const now = Date.now() / 1000.0;
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'param-room', 'test', 'GROUP', to_timestamp(${now}))`
      )
    );

    // Wait for initial callback to resolve the Promise.
    const initialResult = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Initial callback did not fire within 3s")),
        3000
      );

      liveNs
        .query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM rooms WHERE agent_id = $1",
          [agentId],
          (result) => {
            clearTimeout(timeout);
            resolve(parseInt(result.rows[0]?.count ?? "0", 10));
          }
        )
        .catch(reject);
    });

    expect(initialResult).toBeGreaterThanOrEqual(1);
  }, 10_000);
}, 60_000);
