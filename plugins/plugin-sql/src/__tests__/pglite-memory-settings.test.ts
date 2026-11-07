/**
 * In-memory PGlite settings and the maintenance timer: the start params keep
 * PGlite's defaults first, the timer runs only for memory databases and stops
 * on close, and a pass never runs inside an open transaction.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGliteClientManager } from "../pglite/manager";
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SETTINGS_ENV,
  parseMemorySettings,
  withMemorySettings,
} from "../pglite/memory-settings";

const MINUTE = 60_000;
const managers: PGliteClientManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env[MEMORY_SETTINGS_ENV];
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(dataDir = "memory://"): PGliteClientManager {
  const manager = new PGliteClientManager({ dataDir });
  managers.push(manager);
  return manager;
}

describe("parseMemorySettings", () => {
  it("reads name=value pairs separated by commas or spaces", () => {
    expect(parseMemorySettings("shared_buffers=24MB, max_wal_size=64MB work_mem=1MB")).toEqual({
      shared_buffers: "24MB",
      max_wal_size: "64MB",
      work_mem: "1MB",
    });
    expect(parseMemorySettings(undefined)).toEqual({});
    expect(parseMemorySettings(" ,, ")).toEqual({});
  });

  it("rejects anything that is not name=value", () => {
    for (const bad of ["shared_buffers", "shared_buffers=", "=16MB", "Shared=1", "a=b=c"]) {
      expect(() => parseMemorySettings(bad)).toThrow(MEMORY_SETTINGS_ENV);
    }
  });
});

describe("withMemorySettings", () => {
  it("puts PGlite's defaults first, then the settings in order", () => {
    const pairs = Object.entries(DEFAULT_MEMORY_SETTINGS).flatMap(([name, value]) => [
      "-c",
      `${name}=${value}`,
    ]);
    expect(withMemorySettings({ dataDir: "memory://" }, {}).startParams).toEqual([
      ...PGlite.defaultStartParams,
      ...pairs,
    ]);
    // No data dir is also an in-memory database.
    expect(withMemorySettings({}, {}).startParams).toEqual([
      ...PGlite.defaultStartParams,
      ...pairs,
    ]);
  });

  it("lets the environment override a default and add a setting", () => {
    const params = withMemorySettings(
      { dataDir: "memory://" },
      { [MEMORY_SETTINGS_ENV]: "shared_buffers=32MB,work_mem=2MB" }
    ).startParams;
    expect(params?.slice(0, PGlite.defaultStartParams.length)).toEqual(PGlite.defaultStartParams);
    expect(params).toContain("shared_buffers=32MB");
    expect(params).not.toContain("shared_buffers=16MB");
    expect(params?.slice(-2)).toEqual(["-c", "work_mem=2MB"]);
  });

  it("leaves disk databases and callers with their own startParams alone", () => {
    const env = { [MEMORY_SETTINGS_ENV]: "shared_buffers=32MB" };
    expect(withMemorySettings({ dataDir: "/var/data/pglite" }, env)).toEqual({
      dataDir: "/var/data/pglite",
    });
    expect(withMemorySettings({ dataDir: "memory://", startParams: ["--single"] }, env)).toEqual({
      dataDir: "memory://",
      startParams: ["--single"],
    });
  });

  it("throws on a malformed override, so the manager fails at start", () => {
    expect(() =>
      withMemorySettings({ dataDir: "memory://" }, { [MEMORY_SETTINGS_ENV]: "shared_buffers 24MB" })
    ).toThrow(MEMORY_SETTINGS_ENV);
    process.env[MEMORY_SETTINGS_ENV] = "shared_buffers 24MB";
    expect(() => new PGliteClientManager({ dataDir: "memory://" })).toThrow(MEMORY_SETTINGS_ENV);
  });
});

describe("in-memory maintenance timer", () => {
  it("ticks once a minute for a memory database and stops on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pass = vi
      .spyOn(PGliteClientManager.prototype, "runMemoryMaintenance")
      .mockResolvedValue(false);
    const manager = open();
    vi.advanceTimersByTime(MINUTE - 1);
    expect(pass).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pass).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(pass).toHaveBeenCalledTimes(3);
    await manager.close();
    vi.advanceTimersByTime(5 * MINUTE);
    expect(pass).toHaveBeenCalledTimes(3);
  });

  it("starts no timer for a disk database", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const interval = vi.spyOn(globalThis, "setInterval");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-disk-"));
    dirs.push(dir);
    const manager = open(dir);
    await manager.getConnection().waitReady;
    expect(interval).not.toHaveBeenCalled();
    expect(await manager.runMemoryMaintenance()).toBe(false);
  });

  it("does not warn when a tick fails because close() won the race", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const warn = vi.spyOn(logger, "warn");
    let fail!: (error: Error) => void;
    vi.spyOn(PGliteClientManager.prototype, "runMemoryMaintenance").mockImplementation(
      () =>
        new Promise<boolean>((_, reject) => {
          fail = reject;
        })
    );
    const manager = open();
    vi.advanceTimersByTime(MINUTE);
    await manager.close();
    fail(new Error("PGlite is closed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "pglite: in-memory maintenance failed"
    );
  });
});

describe("in-memory maintenance pass", () => {
  it("skips while a raw transaction is open and the transaction still commits", async () => {
    const manager = open();
    const client = manager.getConnection();
    await client.exec("CREATE TABLE churn (id serial PRIMARY KEY, body text NOT NULL)");
    // The migrator sends BEGIN, its statements and COMMIT as separate calls.
    await client.exec("BEGIN");
    for (let i = 0; i < 12; i++) {
      await client.query(
        "INSERT INTO churn (body) SELECT (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 60)) || g FROM generate_series(1, 1000) g"
      );
    }
    const { rows } = await client.query<{ bytes: number }>(
      "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::bigint AS bytes FROM pg_control_checkpoint()"
    );
    expect(Number(rows[0].bytes)).toBeGreaterThan(16 * 1024 * 1024);
    expect(await manager.runMemoryMaintenance()).toBe(false);
    await client.exec("COMMIT");
    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM churn");
    expect(count.rows[0].n).toBe(12_000);
    // Once the transaction is over the next tick runs.
    expect(await manager.runMemoryMaintenance()).toBe(true);
  });

  it("does not break a transaction that starts while a pass is running", async () => {
    const manager = open();
    const client = manager.getConnection();
    await client.exec("CREATE TABLE churn (id serial PRIMARY KEY, body text NOT NULL)");
    for (let i = 0; i < 12; i++) {
      await client.query(
        "INSERT INTO churn (body) SELECT (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 60)) || g FROM generate_series(1, 1000) g"
      );
    }
    const pass = manager.runMemoryMaintenance();
    const tx = (async () => {
      await client.exec("BEGIN");
      await client.query("DELETE FROM churn WHERE id % 2 = 0");
      await client.exec("COMMIT");
    })();
    await Promise.all([pass, tx]);
    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM churn");
    expect(count.rows[0].n).toBe(6_000);
    expect(client.isInTransaction()).toBe(false);
  });
});
