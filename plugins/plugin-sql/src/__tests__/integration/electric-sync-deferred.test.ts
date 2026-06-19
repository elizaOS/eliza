import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

const BOGUS_SYNC_URL = "https://example.invalid/electric";

/**
 * Integration tests for the deferred Electric Sync startup architecture.
 *
 * Core invariant: syncShapesToTables must NOT run before the target tables
 * exist. Tables are created by Drizzle migrations, which run AFTER
 * `PGliteClientManager.initialize()`. So sync is deferred to
 * `ensureSync()`, called lazily from the first `withDatabase()` operation.
 *
 * Phase order:
 *   1. PGliteClientManager.initialize()  → PGlite starts, migrations schema
 *   2. Drizzle migrations                → tables created (agents, memories, …)
 *   3. First withDatabase()              → ensureSync() → startSync()
 */

const CORE_TABLES = [
  "agents",
  "entities",
  "worlds",
  "rooms",
  "participants",
  "memories",
  "relationships",
  "tasks",
] as const;

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Electric Sync deferred startup", () => {
  const cleanups: Array<{ dir: string; manager?: PGliteClientManager }> = [];

  // ── pglite-sync internal unhandled rejection filter ───────────────────
  //
  // The @electric-sql/pglite-sync extension (v0.6.1) launches an async
  // subscription loop via MultiShapeStream. When the sync URL is unreachable
  // (BOGUS_SYNC_URL), two things happen:
  //   1. onError fires (we catch this in startSyncInternal).
  //   2. Internal retry logic (exponential backoff) kicks in. When those
  //      retries fail during close() teardown, the rejection from the
  //      extension's internal promise chain bypasses onError and becomes
  //      an unhandled rejection.
  //
  // Known patterns from pglite-sync v0.6.1 (upstream bug — the async
  // subscribe handler lacks a top-level try/catch):
  //   • "PGlite failed to initialize properly" — internal setup (subscriptions_metadata)
  //   • "Already syncing shape for table …" — concurrent cleanup/retry
  //
  // We filter these specifically so they don't fail CI, but log at debug
  // level for traceability. Any OTHER unhandled rejection (from our code)
  // still surfaces as an error, keeping the safety net intact.
  //
  // Upstream: https://github.com/electric-sql/pglite/issues/962
  //           https://github.com/electric-sql/pglite/issues/641
  const KNOWN_PGLITE_SYNC_REJECTIONS = [
    /PGlite failed to initialize/,
    /Already syncing shape for table/,
    /electric\.subscriptions_metadata does not exist/,
  ];

  let unhandledSuppressor: ((reason: unknown, promise: Promise<unknown>) => void) | null = null;
  beforeAll(() => {
    unhandledSuppressor = (reason: unknown, _promise: Promise<unknown>) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const isKnown = KNOWN_PGLITE_SYNC_REJECTIONS.some((pattern) => pattern.test(msg));
      if (isKnown) {
        console.debug("[test] Suppressed known pglite-sync rejection during teardown:", msg);
      } else {
        // Unknown rejection — log prominently so it's not silently swallowed.
        console.error("[test] UNEXPECTED unhandled rejection (not from pglite-sync):", msg, reason);
      }
    };
    process.on("unhandledRejection", unhandledSuppressor);
  });
  afterAll(() => {
    if (unhandledSuppressor) {
      process.off("unhandledRejection", unhandledSuppressor);
    }
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      // Close the manager first so any sync subscriptions are torn down
      // before we remove the data dir — prevents unhandled rejections
      // from the Electric sync extension trying to read deleted files.
      if (c.manager) {
        try {
          await c.manager.close();
        } catch {}
      }
      // Yield the event loop so any final PGlite WASM cleanup callbacks
      // (extension teardown, file handle release) complete before we
      // remove the data directory. Without this delay, stray async
      // operations may try to read files that no longer exist.
      await new Promise((r) => setTimeout(r, 50));
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ------------------------------------------------------------------
  // Helper: create manager + adapter + run migrations (no sync involved)
  // ------------------------------------------------------------------
  async function setupWithMigrations(opts?: { syncUrl?: string; agentId?: string }): Promise<{
    manager: PGliteClientManager;
    adapter: PgliteDatabaseAdapter;
    agentId: string;
    db: DrizzleDatabase;
  }> {
    const dir = createTempDir("eliza-sync-test-");
    const agentId = opts?.agentId ?? v4();

    const manager = new PGliteClientManager({
      dataDir: dir,
      syncUrl: opts?.syncUrl,
      agentId,
    });

    await manager.initialize();
    // Track for cleanup early — if migrations throw, we still need
    // to close the manager and remove the temp dir.
    cleanups.push({ dir, manager });

    const adapter = new PgliteDatabaseAdapter(agentId as UUID, manager);
    await adapter.init();

    const db = adapter.getDatabase() as DrizzleDatabase;

    // Run migrations so all target tables exist.
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();

    return { manager, adapter, agentId, db };
  }

  // ------------------------------------------------------------------
  // 1. Sync is NOT started during initialize()
  // ------------------------------------------------------------------
  describe("phase ordering", () => {
    it("does not start sync during PGliteClientManager.initialize()", async () => {
      const dir = createTempDir("eliza-sync-noinit-");

      const manager = new PGliteClientManager({ dataDir: dir });
      cleanups.push({ dir, manager });
      await manager.initialize();

      // Before ensureSync() is called, status should be "disabled"
      // (no syncUrl was configured).
      const status = manager.getSyncStatus();
      expect(status.status).toBe("disabled");
      expect(status.error).toBeNull();
      expect(status.synced).toEqual([]);
    });

    it("reports 'disabled' when no ELIZA_ELECTRIC_SYNC_URL is configured", async () => {
      const { manager } = await setupWithMigrations();

      // Trigger ensureSync via getSyncStatus-style check — with no sync URL
      // configured, ensureSync is a no-op and status stays "disabled".
      const status = manager.getSyncStatus();
      expect(status.status).toBe("disabled");
      expect(status.error).toBeNull();
    });

    it("reports 'error' when sync URL is set but agentId is unknown", async () => {
      // Guard against CI environment leaking AGENT_ID into the test.
      const savedAgentId = process.env.AGENT_ID;
      delete process.env.AGENT_ID;
      try {
        const dir = createTempDir("eliza-sync-noagent-");

        // Create manager directly (bypass setupWithMigrations) so we can
        // pass agentId: undefined and have this.agentId stay null. The
        // setupWithMigrations helper always generates a UUID when agentId
        // is falsy, which would defeat this test's purpose.
        const manager = new PGliteClientManager({
          dataDir: dir,
          syncUrl: BOGUS_SYNC_URL,
          agentId: undefined,
        });
        cleanups.push({ dir, manager });
        await manager.initialize();

        // ensureSync() → startSync() checks:
        //   const agentId = this.agentId ?? process.env.AGENT_ID ?? null;
        // Both are null/undefined → hits the !agentId error guard.
        await manager.ensureSync();

        const status = manager.getSyncStatus();
        // With a sync URL but no agentId, startSync() sets status to "error".
        expect(status.status).toBe("error");
        expect(status.error).toContain("agentId");
      } finally {
        if (savedAgentId !== undefined) {
          process.env.AGENT_ID = savedAgentId;
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // 2. Tables exist before sync would start
  // ------------------------------------------------------------------
  describe("table readiness", () => {
    it("all target tables exist after migrations (before sync)", async () => {
      const { db } = await setupWithMigrations();

      // Verify every table that sync would target exists and is queryable.
      for (const table of CORE_TABLES) {
        const result = await db.execute(sql.raw(`SELECT count(*) as cnt FROM ${table}`));
        const rows = result.rows as Array<{ cnt: number }>;
        expect(rows[0]?.cnt).toBe(0);
      }
    });

    it("tables are queryable after migrations complete", async () => {
      const { db, agentId } = await setupWithMigrations();

      // Insert a row into the agents table to prove writes work
      // and the schema matches expectations. Column names are
      // snake_case as defined by the Drizzle schema.
      // Use to_timestamp() since the column type is timestamp with time zone.
      await db.execute(
        sql.raw(
          `INSERT INTO agents (id, name, created_at, updated_at) VALUES ('${agentId}', 'test', to_timestamp(${Date.now() / 1000.0}), to_timestamp(${Date.now() / 1000.0}))`
        )
      );

      const result = await db.execute(
        sql.raw(`SELECT id, name FROM agents WHERE id = '${agentId}'`)
      );
      const rows = result.rows as Array<{ id: string; name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("test");
    });
  });

  // ------------------------------------------------------------------
  // 3. ensureSync() is idempotent
  // ------------------------------------------------------------------
  describe("ensureSync() idempotency", () => {
    it("calling ensureSync() multiple times is safe (no double-start)", async () => {
      const dir = createTempDir("eliza-sync-idem-");
      cleanups.push({ dir });

      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId: v4(),
      });
      cleanups.push({ dir, manager });
      await manager.initialize();

      // First call: should trigger startSync() (which will fail to connect
      // to the bogus URL, setting status to "syncing" → "error").
      await manager.ensureSync();
      const afterFirst = manager.getSyncStatus();

      // Second call: should be a no-op since sync was already started.
      // The guard `if (this.syncUnsubscribe) return;` prevents re-entry.
      await manager.ensureSync();
      const afterSecond = manager.getSyncStatus();

      // Status and error should be stable — no double-initialization
      // skews the in-memory state.
      expect(afterSecond.status).toBe(afterFirst.status);
      expect(afterSecond.error).toBe(afterFirst.error);
    });

    it("ensureSync() before initialize() is a no-op", async () => {
      const dir = createTempDir("eliza-sync-preinit-");
      cleanups.push({ dir });

      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId: v4(),
      });
      // Don't push manager to cleanups — it was never initialized, so
      // calling close() would try to close a PGlite that hasn't been
      // fully started, which can hang. Just clean up the temp dir.

      // ensureSync() checks this.initialized → false, returns early.
      await manager.ensureSync();

      const status = manager.getSyncStatus();
      expect(status.status).toBe("disabled");
    });
  });

  // ------------------------------------------------------------------
  // 4. withDatabase() triggers ensureSync() on first DB operation
  // ------------------------------------------------------------------
  describe("withDatabase() triggers ensureSync()", () => {
    it("first adapter DB operation triggers sync after migrations", async () => {
      const dir = createTempDir("eliza-sync-wdb-");
      cleanups.push({ dir });

      const agentId = v4();

      // Create manager with a syncUrl so ensureSync() has something to
      // attempt (it will fail to the bogus URL, but that proves the code
      // path is exercised).
      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId,
      });
      cleanups.push({ dir, manager });
      await manager.initialize();

      // Before any DB operation, sync should be "disabled".
      expect(manager.getSyncStatus().status).toBe("disabled");

      const adapter = new PgliteDatabaseAdapter(agentId as UUID, manager);
      await adapter.init();

      const db = adapter.getDatabase() as DrizzleDatabase;

      // Run migrations.
      const migrationService = new DatabaseMigrationService();
      await migrationService.initializeWithDatabase(db);
      migrationService.discoverAndRegisterPluginSchemas([
        { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
      ]);
      await migrationService.runAllPluginMigrations();

      // The first withDatabase() call (via createAgent) triggers ensureSync().
      // With a bogus sync URL, startSync() will encounter an error and set
      // status to "error". The key assertion: status is NOT "disabled" — the
      // sync code path was exercised.
      await adapter.createAgent({
        id: agentId as import("@elizaos/core").UUID,
        name: "Test Agent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bio: ["Test bio"],
      } as import("@elizaos/core").Agent);

      const status = manager.getSyncStatus();
      // The sync was attempted — status is no longer "disabled".
      expect(status.status).not.toBe("disabled");
    });

    it("sync stays disabled when no syncUrl is configured (no-op path)", async () => {
      const { adapter, agentId, manager } = await setupWithMigrations();

      // First DB operation — ensureSync() is called but with no syncUrl,
      // startSync() immediately returns with status "disabled".
      await adapter.createAgent({
        id: agentId as import("@elizaos/core").UUID,
        name: "Test Agent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bio: ["Test bio"],
      } as import("@elizaos/core").Agent);

      const status = manager.getSyncStatus();
      expect(status.status).toBe("disabled");
      expect(status.error).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // 5. Force resync preserves local data, resets sync state
  // ------------------------------------------------------------------
  describe("forceResync()", () => {
    it("returns null when no syncUrl is configured", async () => {
      const { manager } = await setupWithMigrations();
      const result = await manager.forceResync();
      expect(result).toBeNull();
    });

    it("preserves local data after force resync with bogus URL", async () => {
      const dir = createTempDir("eliza-sync-fr-");
      cleanups.push({ dir });

      const agentId = v4();
      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId,
      });
      cleanups.push({ dir, manager });
      await manager.initialize();

      const adapter = new PgliteDatabaseAdapter(agentId as UUID, manager);
      await adapter.init();

      const db = adapter.getDatabase() as DrizzleDatabase;

      // Run migrations + create agent.
      const migrationService = new DatabaseMigrationService();
      await migrationService.initializeWithDatabase(db);
      migrationService.discoverAndRegisterPluginSchemas([
        { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
      ]);
      await migrationService.runAllPluginMigrations();

      await adapter.createAgent({
        id: agentId as import("@elizaos/core").UUID,
        name: "Test Agent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bio: ["Test bio"],
      } as import("@elizaos/core").Agent);

      // Force resync to invalid URL — should attempt, DROP electric schema
      // if it exists, reset state, and re-attempt sync.
      const result = await manager.forceResync();
      expect(result).not.toBeNull();
      expect(result!.status).toMatch(/^(error|syncing|synced)$/);

      // Verify local data survived.
      const agent = await adapter.getAgent(agentId as import("@elizaos/core").UUID);
      expect(agent).not.toBeNull();
      expect(agent?.name).toBe("Test Agent");
    });

    it("DROP SCHEMA electric CASCADE executes without error and PGlite survives", async () => {
      const dir = createTempDir("eliza-sync-drop-");
      cleanups.push({ dir });

      const agentId = v4();
      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId,
      });
      cleanups.push({ dir, manager });
      await manager.initialize();

      // Start sync so the electric schema may be created by the extension.
      await manager.ensureSync();

      // Trigger force resync — exercises DROP SCHEMA electric CASCADE,
      // state reset, and re-attempted startSync.
      const result = await manager.forceResync();
      expect(result).not.toBeNull();
      expect(result!.status).toMatch(/^(error|syncing|synced)$/);

      // PGlite must still be functional after the DROP + re-sync.
      const client = manager.getConnection();
      const checkResult = await client.query("SELECT 1 AS alive");
      expect((checkResult.rows as Array<{ alive: number }>)[0]?.alive).toBe(1);
    });

    it("re-sync restores per-table state from reset to populated", async () => {
      const dir = createTempDir("eliza-sync-restore-");
      cleanups.push({ dir });

      const agentId = v4();
      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId,
      });
      cleanups.push({ dir, manager });
      await manager.initialize();

      // Start sync — populates per-table state (8+ table entries).
      await manager.ensureSync();
      const beforeStatus = manager.getSyncStatus();
      const beforeTableKeys = Object.keys(beforeStatus.tables);
      // startSync populates syncTableStates for all configured tables.
      expect(beforeTableKeys.length).toBeGreaterThanOrEqual(8);
      for (const key of beforeTableKeys) {
        expect(beforeStatus.tables[key]?.state).toMatch(/^(pending|synced|error)$/);
      }

      // Force resync — clears tables and synced arrays, then calls
      // startSync again which re-populates them.
      const afterResync = await manager.forceResync();
      expect(afterResync).not.toBeNull();

      // After re-sync, tables should be re-populated (same or similar keys).
      expect(Object.keys(afterResync!.tables).length).toBeGreaterThanOrEqual(8);
      for (const key of Object.keys(afterResync!.tables)) {
        expect(afterResync!.tables[key]?.state).toMatch(/^(pending|synced|error)$/);
      }

      // Status should be a valid state after re-sync attempt.
      expect(afterResync!.status).toMatch(/^(error|syncing|synced)$/);
    });

    it("concurrent forceResync calls are safe and return consistent results", async () => {
      const dir = createTempDir("eliza-sync-concur-");
      cleanups.push({ dir });

      const agentId = v4();
      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId,
      });
      cleanups.push({ dir, manager });
      await manager.initialize();

      // Start sync so forceResync has something to unwind.
      await manager.ensureSync();

      // Call forceResync twice concurrently — neither should throw,
      // and both should agree on the final status.
      const [r1, r2] = await Promise.all([manager.forceResync(), manager.forceResync()]);

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1!.status).toMatch(/^(error|syncing|synced)$/);
      expect(r2!.status).toMatch(/^(error|syncing|synced)$/);
      // Both results should agree on status — no corruption.
      expect(r1!.status).toBe(r2!.status);
    });
  });

  // ------------------------------------------------------------------
  // 6. Full lifecycle: init → migrate → first DB op → sync triggered
  // ------------------------------------------------------------------
  describe("full lifecycle", () => {
    it("completes the init→migrate→write→sync dance in order", async () => {
      const dir = createTempDir("eliza-sync-lifecycle-");
      cleanups.push({ dir });

      const agentId = v4();

      // Phase 1: Create and initialize manager — sync NOT started.
      const manager = new PGliteClientManager({
        dataDir: dir,
        syncUrl: BOGUS_SYNC_URL,
        agentId,
      });
      cleanups.push({ dir, manager });
      await manager.initialize();
      expect(manager.getSyncStatus().status).toBe("disabled");

      // Phase 2: Create adapter, run migrations.
      const adapter = new PgliteDatabaseAdapter(agentId as UUID, manager);
      await adapter.init();

      const db = adapter.getDatabase() as DrizzleDatabase;
      const migrationService = new DatabaseMigrationService();
      await migrationService.initializeWithDatabase(db);
      migrationService.discoverAndRegisterPluginSchemas([
        { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
      ]);
      await migrationService.runAllPluginMigrations();

      // Phase 3: Verify all tables exist and are empty.
      for (const table of CORE_TABLES) {
        const result = await db.execute(sql.raw(`SELECT count(*) as cnt FROM ${table}`));
        expect((result.rows as Array<{ cnt: number }>)[0]?.cnt).toBe(0);
      }

      // Phase 4: First write triggers ensureSync() → startSync().
      // With bogus URL, sync will error, but the write succeeds.
      await adapter.createAgent({
        id: agentId as import("@elizaos/core").UUID,
        name: "Lifecycle Test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bio: ["Test"],
      } as import("@elizaos/core").Agent);

      // Phase 5: Sync was attempted (no longer "disabled").
      const status = manager.getSyncStatus();
      expect(status.status).not.toBe("disabled");

      // Phase 6: Data survives.
      const agent = await adapter.getAgent(agentId as import("@elizaos/core").UUID);
      expect(agent).not.toBeNull();
      expect(agent?.name).toBe("Lifecycle Test");
    });
  });
}, 60_000);
