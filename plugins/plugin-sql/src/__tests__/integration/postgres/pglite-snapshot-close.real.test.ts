/**
 * Proves snapshot checkpoint-and-close against a real file-backed PGlite
 * database, including durable reopen and release of the single-writer lock.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PGliteClientManager } from "../../../pglite/manager.ts";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { force: true, recursive: true })));
  roots.clear();
});

describe("PGlite snapshot close", () => {
  test("checkpoints durable state, closes the writer, and permits a clean reopen", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-pglite-snapshot-close-"));
    roots.add(root);
    const dataDir = path.join(root, "database");
    const first = new PGliteClientManager({ dataDir });
    await first.initialize();
    await first
      .getConnection()
      .exec(
        "CREATE TABLE snapshot_probe (value TEXT NOT NULL); INSERT INTO snapshot_probe VALUES ('durable');"
      );

    await first.checkpointAndCloseForSnapshot();
    expect(first.isShuttingDown()).toBe(true);
    await expect(first.getConnection().query("SELECT * FROM snapshot_probe")).rejects.toThrow();

    const reopened = new PGliteClientManager({ dataDir });
    try {
      await reopened.initialize();
      const result = await reopened
        .getConnection()
        .query<{ value: string }>("SELECT value FROM snapshot_probe");
      expect(result.rows).toEqual([{ value: "durable" }]);
    } finally {
      await reopened.close();
    }
  });

  test("fails closed while Electric Sync can still schedule delayed writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-pglite-snapshot-sync-"));
    roots.add(root);
    const manager = new PGliteClientManager({ dataDir: path.join(root, "database") });
    await manager.initialize();
    let unsubscribeCalled = false;
    const internal = manager as unknown as {
      syncUnsubscribe: (() => void) | null;
    };
    internal.syncUnsubscribe = () => {
      unsubscribeCalled = true;
      setTimeout(() => {
        void manager.getConnection().exec("SELECT 1");
      }, 75);
    };

    await expect(manager.checkpointAndCloseForSnapshot()).rejects.toMatchObject({
      code: "PGLITE_SNAPSHOT_ELECTRIC_SYNC_ACTIVE",
    });
    expect(unsubscribeCalled).toBe(false);
    expect(manager.isShuttingDown()).toBe(true);
    await expect(manager.getConnection().query("SELECT 1")).resolves.toBeDefined();

    internal.syncUnsubscribe = null;
    await manager.close();
  });
});
