/** Adapter availability, shutdown fences and bounded backup delegation. */

import type { UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgliteDatabaseAdapter } from "../pglite/adapter";

const agentId = "00000000-0000-4000-8000-000000000001" as UUID;
const memoryId = "00000000-0000-4000-8000-000000000005" as UUID;
const relationshipId = "00000000-0000-4000-8000-000000000006" as UUID;

function makeAdapter() {
  const rawConnection = {
    query: vi.fn(async (query: string) => {
      if (query.includes("participants")) {
        return { rows: [{ id: "participant-row" }] };
      }
      if (query.includes("relationships")) {
        return { rows: [{ id: relationshipId }] };
      }
      if (query.includes("memories")) {
        return { rows: [{ id: memoryId }] };
      }
      return { rows: [] };
    }),
  };
  const manager = {
    close: vi.fn(async () => undefined),
    dumpDataDir: vi.fn(async () => new Blob(["snapshot"])),
    dumpDataDirAfterPreflight: vi.fn(async <T>(preflight: () => Promise<T>) => ({
      dump: new Blob(["bounded-snapshot"]),
      preflight: await preflight(),
      release: vi.fn(),
    })),
    getConnection: vi.fn(() => rawConnection),
    getDataDir: vi.fn(() => "/tmp/pglite-test"),
    initialize: vi.fn(async () => undefined),
    isInitialized: vi.fn(() => true),
    isShuttingDown: vi.fn(() => false),
  };
  const adapter = new PgliteDatabaseAdapter(agentId, manager as never);
  const db = {
    execute: vi.fn(async () => ({ rows: [{ id: "write-row", "?column?": 1 }] })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  (adapter as unknown as { db: typeof db }).db = db;
  return { adapter, db, manager, rawConnection };
}

describe("PgliteDatabaseAdapter liveness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a real SELECT probe and fails closed when the handle is closed", async () => {
    const { adapter, db, manager } = makeAdapter();

    await expect(adapter.isReady()).resolves.toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(1);

    db.execute.mockRejectedValueOnce(new Error("PGlite is closed"));
    await expect(adapter.isReady()).resolves.toBe(false);

    manager.isShuttingDown.mockReturnValueOnce(true);
    await expect(adapter.isReady()).resolves.toBe(false);

    manager.isInitialized.mockReturnValueOnce(false);
    await expect(adapter.isReady()).resolves.toBe(false);
  });

  it("keeps initialization, transaction, connection, close, and shutdown rejection semantics", async () => {
    const { adapter, db, manager, rawConnection } = makeAdapter();

    await expect(adapter.init()).resolves.toBeUndefined();
    await expect(adapter.getConnection()).resolves.toBe(db);
    expect(adapter.getRawConnection()).toBe(rawConnection);
    expect(adapter.getPgliteDataDir()).toBe("/tmp/pglite-test");
    await expect(adapter.dumpPgliteDataDir("gzip")).resolves.toBeInstanceOf(Blob);
    expect(manager.dumpDataDir).toHaveBeenCalledWith("gzip");
    await expect(
      adapter.dumpPgliteDataDirAfterPreflight(async () => "bounded", "gzip")
    ).resolves.toEqual({
      dump: expect.any(Blob),
      preflight: "bounded",
      release: expect.any(Function),
    });
    expect(manager.dumpDataDirAfterPreflight).toHaveBeenCalledWith(expect.any(Function), "gzip");
    await expect(
      adapter.withEntityContext(null, async (tx) => {
        expect(tx).toBe(db);
        return "ok";
      })
    ).resolves.toBe("ok");
    await expect(
      (
        adapter as unknown as {
          withDatabase: <T>(operation: () => Promise<T>) => Promise<T>;
        }
      ).withDatabase(async () => "ready")
    ).resolves.toBe("ready");

    manager.isShuttingDown.mockReturnValueOnce(true);
    await expect(
      (
        adapter as unknown as {
          withDatabase: <T>(operation: () => Promise<T>) => Promise<T>;
        }
      ).withDatabase(async () => "never")
    ).rejects.toThrow("Database is shutting down - operation rejected");

    await adapter.close();
    expect(manager.close).toHaveBeenCalledTimes(1);
  });
});
