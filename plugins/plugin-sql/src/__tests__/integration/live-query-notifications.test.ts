/**
 * Verifies PGlite change notifications on the `live.query()` pipeline used by
 * database-status clients. Callback timing is logged as telemetry; functional
 * correctness does not depend on a machine-specific latency threshold.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const LIVE_EXTENSION_SENTINEL_URL = "https://example.invalid/electric";

describe("Live query notifications", () => {
  const cleanups: Array<{ dir: string; manager?: PGliteClientManager }> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      if (c.manager) {
        try {
          await c.manager.close();
        } catch {
          // error-policy:J6 test teardown continues so every temporary
          // database directory gets a cleanup attempt.
        }
      }
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
      } catch {
        // error-policy:J6 the OS may still hold PGlite files briefly; the
        // temporary directory is isolated from product state.
      }
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
      // The manager loads `pg.live` only for Electric-enabled databases. Raw
      // Drizzle operations below do not start sync or contact this URL.
      syncUrl: LIVE_EXTENSION_SENTINEL_URL,
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

  type LiveQueryNamespace = NonNullable<ReturnType<PGliteClientManager["liveQuery"]>>;

  async function observeCountChange(
    liveNs: LiveQueryNamespace,
    query: string,
    isExpected: (count: number, initialCount: number) => boolean
  ): Promise<{
    initialCount: number;
    updatedCount: Promise<number>;
    unsubscribe: () => Promise<void>;
  }> {
    let initialCount: number | undefined;
    let resolveInitial!: (count: number) => void;
    let rejectInitial!: (error: unknown) => void;
    let resolveUpdated!: (count: number) => void;
    let rejectUpdated!: (error: unknown) => void;
    const initial = new Promise<number>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    const updatedCount = new Promise<number>((resolve, reject) => {
      resolveUpdated = resolve;
      rejectUpdated = reject;
    });

    const subscription = await liveNs.query<{ count: string | number }>(query, [], (result) => {
      try {
        const rawCount = result.rows[0]?.count;
        if (rawCount === undefined) {
          throw new Error("Live count query returned no count column.");
        }
        const count = Number.parseInt(String(rawCount), 10);
        if (!Number.isFinite(count)) {
          throw new Error(`Live count query returned an invalid count: ${rawCount}`);
        }
        if (initialCount === undefined) {
          initialCount = count;
          resolveInitial(count);
          return;
        }
        if (isExpected(count, initialCount)) {
          resolveUpdated(count);
        }
      } catch (error) {
        rejectInitial(error);
        rejectUpdated(error);
      }
    });

    return {
      initialCount: await initial,
      updatedCount,
      unsubscribe: subscription.unsubscribe,
    };
  }

  it("emits a memories count update after an INSERT", async () => {
    const { manager, db, agentId } = await setupPGlite();
    const liveNs = manager.liveQuery();
    expect(liveNs).not.toBeNull();
    if (!liveNs) throw new Error("PGlite live query extension is unavailable.");

    const roomId = v4();
    const now = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'test-room', 'test', 'GROUP', to_timestamp(${now / 1000.0}))`
      )
    );
    const observation = await observeCountChange(
      liveNs,
      "SELECT COUNT(*)::text AS count FROM memories",
      (count, initialCount) => count === initialCount + 1
    );

    try {
      const startedAt = performance.now();
      await db.execute(
        sql.raw(
          `INSERT INTO memories (id, type, agent_id, room_id, content, created_at) VALUES ('${v4()}', 'test', '${agentId}', '${roomId}', '{"text":"notification test"}'::jsonb, to_timestamp(${Date.now() / 1000.0}))`
        )
      );
      const count = await observation.updatedCount;
      logger.info(
        `[LiveQueryTelemetry] memories_insert_to_callback_ms=${(performance.now() - startedAt).toFixed(3)}`
      );
      expect(count).toBe(observation.initialCount + 1);
    } finally {
      await observation.unsubscribe();
    }
  }, 10_000);

  it("coalesces multiple INSERTs into an accurate memories count", async () => {
    const { manager, db, agentId } = await setupPGlite();
    const liveNs = manager.liveQuery();
    expect(liveNs).not.toBeNull();
    if (!liveNs) throw new Error("PGlite live query extension is unavailable.");

    const roomId = v4();
    const now = Date.now();
    await db.execute(
      sql.raw(
        `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${roomId}', '${agentId}', 'test-room', 'test', 'GROUP', to_timestamp(${now / 1000.0}))`
      )
    );
    const observation = await observeCountChange(
      liveNs,
      "SELECT COUNT(*)::text AS count FROM memories",
      (count, initialCount) => count === initialCount + 3
    );

    try {
      for (let index = 0; index < 3; index++) {
        await db.execute(
          sql.raw(
            `INSERT INTO memories (id, type, agent_id, room_id, content, created_at) VALUES ('${v4()}', 'test', '${agentId}', '${roomId}', '{"text":"batch ${index}"}'::jsonb, to_timestamp(${Date.now() / 1000.0}))`
          )
        );
      }
      const count = await observation.updatedCount;
      expect(count).toBe(observation.initialCount + 3);
    } finally {
      await observation.unsubscribe();
    }
  }, 10_000);

  it("emits a rooms count update after an INSERT", async () => {
    const { manager, db, agentId } = await setupPGlite();
    const liveNs = manager.liveQuery();
    expect(liveNs).not.toBeNull();
    if (!liveNs) throw new Error("PGlite live query extension is unavailable.");

    const observation = await observeCountChange(
      liveNs,
      "SELECT COUNT(*)::text AS count FROM rooms",
      (count, initialCount) => count === initialCount + 1
    );

    try {
      const startedAt = performance.now();
      await db.execute(
        sql.raw(
          `INSERT INTO rooms (id, agent_id, name, source, type, created_at) VALUES ('${v4()}', '${agentId}', 'test-room-2', 'test', 'GROUP', to_timestamp(${Date.now() / 1000.0}))`
        )
      );
      const count = await observation.updatedCount;
      logger.info(
        `[LiveQueryTelemetry] rooms_insert_to_callback_ms=${(performance.now() - startedAt).toFixed(3)}`
      );
      expect(count).toBe(observation.initialCount + 1);
    } finally {
      await observation.unsubscribe();
    }
  }, 10_000);
}, 60_000);
