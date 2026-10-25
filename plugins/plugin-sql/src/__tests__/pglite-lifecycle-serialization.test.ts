/**
 * Proves the production PGlite manager serializes data-directory snapshots
 * with client teardown so neither operation can observe a half-closed handle.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGliteClientManager } from "../pglite/manager";

async function waitForAssertion(assertion: () => void, maxAttempts = 1_000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

describe("PGlite snapshot lifecycle serialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds close until an admitted bounded export is fully consumed", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    let releaseDump!: (value: Blob) => void;
    const dumpSpy = vi.spyOn(client, "dumpDataDir").mockImplementation(
      async () =>
        await new Promise<Blob>((resolve) => {
          releaseDump = resolve;
        })
    );
    const closeSpy = vi.spyOn(client, "close").mockResolvedValue(undefined);

    const dumpPromise = manager.dumpDataDirAfterPreflight(async () => "bounded", "gzip");
    const closePromise = manager.close();
    await waitForAssertion(() => expect(dumpSpy).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();

    releaseDump(new Blob(["snapshot"]));
    const bounded = await dumpPromise;
    expect(bounded).toEqual({
      dump: expect.any(Blob),
      preflight: "bounded",
      release: expect.any(Function),
    });
    await Promise.resolve();
    expect(closeSpy).not.toHaveBeenCalled();

    bounded.release();
    await expect(closePromise).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a dump admitted after close without touching the client", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    const dumpSpy = vi.spyOn(client, "dumpDataDir");
    const closeSpy = vi.spyOn(client, "close").mockResolvedValue(undefined);

    const closePromise = manager.close();
    await expect(manager.dumpDataDirAfterPreflight(async () => "bounded", "gzip")).rejects.toThrow(
      "PGlite is closing"
    );
    await expect(closePromise).resolves.toBeUndefined();
    expect(dumpSpy).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("fences preflight and dump ahead of competing query work", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    const events: string[] = [];
    let releaseDump!: (value: Blob) => void;
    vi.spyOn(client, "dumpDataDir").mockImplementation(
      async () =>
        await new Promise<Blob>((resolve) => {
          events.push("dump:start");
          releaseDump = (value) => {
            events.push("dump:end");
            resolve(value);
          };
        })
    );
    vi.spyOn(client, "close").mockResolvedValue(undefined);

    const dumpPromise = manager.dumpDataDirAfterPreflight(async () => {
      events.push("preflight");
      return "bounded";
    });
    await waitForAssertion(() => expect(events).toEqual(["preflight", "dump:start"]));

    const competingQuery = client.runExclusive(async () => {
      events.push("query");
    });
    await Promise.resolve();
    expect(events).toEqual(["preflight", "dump:start"]);

    releaseDump(new Blob(["snapshot"]));
    const bounded = await dumpPromise;
    expect(bounded).toEqual({
      dump: expect.any(Blob),
      preflight: "bounded",
      release: expect.any(Function),
    });
    await expect(competingQuery).resolves.toBeUndefined();
    expect(events).toEqual(["preflight", "dump:start", "dump:end", "query"]);
    bounded.release();
    await manager.close();
  });

  it("blocks the legacy exporter while a bounded Blob consumer owns the shared lease", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    const dumpSpy = vi
      .spyOn(client, "dumpDataDir")
      .mockResolvedValue(new Blob(["bounded-snapshot"]));
    vi.spyOn(client, "close").mockResolvedValue(undefined);

    const bounded = await manager.dumpDataDirAfterPreflight(async () => "bounded", "gzip");
    await expect(manager.dumpDataDir("gzip")).rejects.toMatchObject({
      code: "PGLITE_DATA_DIR_EXPORT_BUSY",
    });
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    bounded.release();
    await expect(manager.dumpDataDir("gzip")).rejects.toMatchObject({
      code: "PGLITE_DATA_DIR_EXPORT_UNBOUNDED",
    });
    expect(dumpSpy).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it("releases the shared lease when preflight rejects before materialization", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    const dumpSpy = vi
      .spyOn(client, "dumpDataDir")
      .mockResolvedValue(new Blob(["bounded-snapshot"]));
    vi.spyOn(client, "close").mockResolvedValue(undefined);

    await expect(
      manager.dumpDataDirAfterPreflight(async () => {
        throw new Error("preflight refused");
      })
    ).rejects.toThrow("preflight refused");
    expect(dumpSpy).not.toHaveBeenCalled();

    const second = await manager.dumpDataDirAfterPreflight(async () => "bounded", "gzip");
    expect(dumpSpy).toHaveBeenCalledTimes(1);
    second.release();
    await manager.close();
  });

  it("restores the pre-write state while a competing real write waits for the dump fence", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pglite-bounded-dump-"));
    const sourceDir = path.join(root, "source");
    const restoredDir = path.join(root, "restored");
    const previousDisableExtensions = process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS;
    process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS = "1";
    const manager = new PGliteClientManager({ dataDir: sourceDir });
    let restored: PGlite | undefined;
    let releaseBounded: (() => void) | undefined;
    try {
      const client = manager.getConnection();
      await client.exec(
        "CREATE TABLE backup_fence_marker (value text PRIMARY KEY); INSERT INTO backup_fence_marker VALUES ('before');"
      );

      let releasePreflight!: () => void;
      const preflightBlocked = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      let preflightEntered = false;
      const dumpPromise = manager.dumpDataDirAfterPreflight(async () => {
        preflightEntered = true;
        await preflightBlocked;
        return "physical-size-proven";
      });
      await waitForAssertion(() => expect(preflightEntered).toBe(true));

      let competingWriteSettled = false;
      const competingWrite = client
        .query("INSERT INTO backup_fence_marker VALUES ('after')")
        .then(() => {
          competingWriteSettled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(competingWriteSettled).toBe(false);

      releasePreflight();
      const bounded = await dumpPromise;
      releaseBounded = bounded.release;
      await competingWrite;
      expect(bounded.preflight).toBe("physical-size-proven");

      restored = new PGlite({
        dataDir: restoredDir,
        loadDataDir: bounded.dump,
      });
      await restored.waitReady;
      const restoredRows = await restored.query<{ value: string }>(
        "SELECT value FROM backup_fence_marker ORDER BY value"
      );
      expect(restoredRows.rows).toEqual([{ value: "before" }]);
      releaseBounded();
      releaseBounded = undefined;
      await manager.close();
    } finally {
      await restored?.close();
      releaseBounded?.();
      await manager.close();
      if (previousDisableExtensions === undefined) {
        delete process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS;
      } else {
        process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS = previousDisableExtensions;
      }
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
