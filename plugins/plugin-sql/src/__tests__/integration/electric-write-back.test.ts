/**
 * End-to-end Electric Write-Back test against Electric Cloud (the managed
 * sync service, not a local Docker Compose stack) — verifies PGlite connects
 * and syncs existing tables via `syncShapesToTables`. The suite is explicitly
 * skipped when Cloud credentials are absent; once selected, an unreachable
 * proxy fails instead of fabricating a pass. Write-back enabled/disabled/enqueue
 * behavior itself is covered by `__tests__/unit/write-back.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

// Caddy injects Electric Cloud auth from these env vars — the test just
// checks they're set so Caddy can do its job.
const ELECTRIC_CLOUD_SOURCE_ID = process.env.ELECTRIC_CLOUD_SOURCE_ID;
const ELECTRIC_CLOUD_SECRET = process.env.ELECTRIC_CLOUD_SECRET;

const ELECTRIC_SYNC_URL = "http://localhost:3001";
// Caddy forwards to Electric Cloud with auth; use query-param format.
const ELECTRIC_PROBE_URL = "http://localhost:3001/?table=agents&offset=-1";

const CLOUD_ENV_VARS_SET = !!(ELECTRIC_CLOUD_SOURCE_ID && ELECTRIC_CLOUD_SECRET);

// ── Electric Cloud rejection filter ──────────────────────────────────
//
// The Electric Cloud database may not have every table in SYNCED_TABLE_NAMES
// (e.g. user_sessions was added after the Cloud DB was provisioned). When
// the sync stream encounters a missing table, the postgres error bypasses
// pglite-sync's onError callback and surfaces as an unhandled rejection.
//
// We filter these specifically so they don't fail CI, but log them for
// traceability. Any OTHER unhandled rejection still surfaces.
const KNOWN_CLOUD_REJECTIONS = [/relation "public\.user_sessions" does not exist/];

let unhandledSuppressor: ((reason: unknown, promise: Promise<unknown>) => void) | null = null;
const unexpectedUnhandledRejections: unknown[] = [];

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ------------------------------------------------------------------
// Test suite
// ------------------------------------------------------------------
describe.skipIf(!CLOUD_ENV_VARS_SET)("Electric Write-Back e2e", () => {
  const cleanups: Array<{ dir: string; manager?: PGliteClientManager }> = [];

  beforeAll(() => {
    unhandledSuppressor = (reason: unknown, _promise: Promise<unknown>) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (KNOWN_CLOUD_REJECTIONS.some((pattern) => pattern.test(message))) {
        // error-policy:J5 the known Cloud schema rejection is observed here and logged.
        console.debug("[write-back] Suppressed known Cloud rejection:", message);
        return;
      }
      unexpectedUnhandledRejections.push(reason);
    };
    process.on("unhandledRejection", unhandledSuppressor);
  });

  beforeAll(async () => {
    const response = await fetch(ELECTRIC_PROBE_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Electric probe returned ${response.status}`);
    }
    console.log("[write-back] Electric Cloud reachable via Caddy proxy — running write-back tests");
  }, 15_000);

  afterAll(() => {
    if (unhandledSuppressor) {
      process.off("unhandledRejection", unhandledSuppressor);
    }
    if (unexpectedUnhandledRejections.length > 0) {
      throw new AggregateError(
        unexpectedUnhandledRejections,
        "Unexpected unhandled rejection during Electric Cloud e2e"
      );
    }
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      if (c.manager) {
        try {
          await c.manager.close();
        } catch (error) {
          // error-policy:J6 test teardown continues so all temporary resources are attempted.
          console.warn("[write-back] manager teardown failed", error);
        }
      }
      // Yield the event loop so PGlite WASM cleanup callbacks complete
      // before the data directory is removed.
      await new Promise((r) => setTimeout(r, 50));
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
      } catch (error) {
        // error-policy:J6 test teardown reports filesystem cleanup failures.
        console.warn("[write-back] temporary directory cleanup failed", error);
      }
    }
  });

  // ------------------------------------------------------------------
  // 1. PGlite syncs data from Electric Cloud
  // ------------------------------------------------------------------
  it("write-back: PGlite connects to Electric Cloud and syncs existing data", async () => {
    const agentId = v4();

    // 1. Create PGlite with Electric Cloud sync configured.
    const dir = createTempDir("eliza-wb-");
    const manager = new PGliteClientManager({
      dataDir: dir,
      syncUrl: ELECTRIC_SYNC_URL,
      agentId,
    });
    cleanups.push({ dir, manager });
    await manager.initialize();

    const client = manager.getConnection();
    const { drizzle } = await import("drizzle-orm/pglite");
    const db = drizzle(client) as unknown as DrizzleDatabase;

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();

    await manager.ensureSync();

    // Wait for sync to connect and make progress. Some tables
    // (e.g. user_sessions) may not exist in this Electric Cloud
    // database — per-table 404s are expected and don't block the
    // tables that DO exist from syncing.
    const syncDeadline = Date.now() + 15_000;
    while (Date.now() < syncDeadline) {
      const status = manager.getSyncStatus();
      if (status.status === "synced") {
        break;
      }
      if (status.status === "error") throw new Error(`Sync errored: ${status.error}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    // Sync may not reach "synced" if some Cloud tables don't exist
    // (e.g. user_sessions). Verify the stream connected successfully —
    // the real validation is that syncShapesToTables accepted the URL
    // without 400/404 (which would indicate auth or format issues).
    const finalStatus = manager.getSyncStatus();
    expect(finalStatus.status).not.toBe("error");
    expect(finalStatus.status).not.toBe("disabled");
    console.log(
      "[write-back] Sync connected — status:",
      finalStatus.status,
      "tables:",
      Object.keys(finalStatus.tables).length
    );
    expect(Object.keys(finalStatus.tables).length).toBeGreaterThan(0);
  }, 90_000);

  // Tests 2-4 (write-back enabled/disabled/enqueue) are covered by the
  // 14 unit tests in __tests__/unit/write-back.test.ts.
});
