/**
 * Restart-safety proof for the content-manifest ledger (#25141): a writer
 * PGlite manager over a real filesystem dataDir publishes a ledger and closes;
 * a completely fresh manager + adapter reopens the same dataDir and traverses
 * every shard with full integrity verification. Real PGlite throughout; no
 * mocks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompactionContentEntry } from "@elizaos/core";
import {
  type ContentManifestLedgerStore,
  loadManifestLedger,
  publishManifestLedger,
  validateCompactionContentManifest,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";

function makeEntry(index: number): CompactionContentEntry {
  return {
    reference: { kind: "file", ref: `restart-${index}.txt`, revision: `r${index}` },
    reason: "tool:FILE",
    rangesUsed: [
      { unit: "byte", start: index * 10, end: index * 10 + 10 },
      { unit: "byte", start: index * 100, end: index * 100 + 50 },
    ],
    lastUsedAt: "2026-08-27T00:00:00.000Z",
    retained: true,
  };
}

function makeManifest(count: number) {
  return validateCompactionContentManifest({
    schemaVersion: 1,
    contentRefs: Array.from({ length: count }, (_, i) => makeEntry(i)),
    modifiedFiles: [],
    pendingProcesses: [],
  });
}

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const LEDGER = `${AGENT_ID}:trajectory:restart-t1`;

describe("content-manifest ledger restart safety over a filesystem PGlite data dir", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "manifest-ledger-restart-"));
  });

  afterAll(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it("writer publishes, exits; a fresh adapter reopens and traverses every shard", async () => {
    const dataDir = path.join(root, "data");
    const manifest = makeManifest(11);

    // ── Writer phase: boot manager, run migrations, publish, close ──
    {
      const manager = new PGliteClientManager({ dataDir });
      await manager.initialize();
      const adapter = new PgliteDatabaseAdapter(AGENT_ID, manager);
      await adapter.init();
      const migrationService = new DatabaseMigrationService();
      await migrationService.initializeWithDatabase(
        adapter.getDatabase() as Parameters<DatabaseMigrationService["initializeWithDatabase"]>[0]
      );
      migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
      await migrationService.runAllPluginMigrations();
      const created = await adapter.createAgent({
        id: AGENT_ID,
        name: "manifest-ledger-restart-writer",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      if (!created) throw new Error("writer agent row not created");

      const head = await publishManifestLedger(
        adapter as unknown as ContentManifestLedgerStore,
        LEDGER,
        manifest,
        { maxEntriesPerShard: 3 }
      );
      expect(head.shardCount).toBe(4);
      expect(head.revision).toBe(0);
      // Full teardown: this is the "writer exits" boundary.
      await adapter.close();
      await manager.close();
    }

    // ── Reader phase: completely fresh manager + adapter, same disk bytes ──
    {
      const manager = new PGliteClientManager({ dataDir });
      await manager.initialize();
      const adapter = new PgliteDatabaseAdapter(AGENT_ID, manager);
      await adapter.init();

      const loaded = await loadManifestLedger(
        adapter as unknown as ContentManifestLedgerStore,
        LEDGER
      );
      expect(loaded.entries).toHaveLength(11);
      expect(loaded.entries.map((e) => e.reference.ref)).toEqual(
        manifest.contentRefs.map((e) => e.reference.ref)
      );
      expect(loaded.shards).toHaveLength(4);
      // Chain + integrity verified inside loadManifestLedger; reaching
      // here means every hash, link, and total reconciled after restart.
      await adapter.close();
      await manager.close();
    }
  }, 120_000);
});
