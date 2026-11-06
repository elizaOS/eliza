/**
 * Real PGlite: an in-memory database starts with the smaller buffer and WAL
 * settings on top of PGlite's defaults, runs the plugin migrations, and its
 * maintenance pass frees WAL segments and lets deleted rows be reused.
 */

import { PGlite } from "@electric-sql/pglite";
import type { UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../migration-service";
import { PgliteDatabaseAdapter } from "../pglite/adapter";
import { PGliteClientManager } from "../pglite/manager";
import { MEMORY_SETTINGS_ENV, withMemorySettings } from "../pglite/memory-settings";
import { schema } from "../schema";
import type { DrizzleDatabase } from "../types";

const managers: PGliteClientManager[] = [];
afterEach(async () => {
  delete process.env[MEMORY_SETTINGS_ENV];
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

function open(): PGliteClientManager {
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  managers.push(manager);
  return manager;
}

async function setting(client: PGlite, name: string): Promise<string> {
  const { rows } = await client.query<Record<string, string>>(`SHOW ${name}`);
  return rows[0][name];
}

async function walSegments(client: PGlite): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_ls_waldir()"
  );
  return rows[0].n;
}

async function tableBytes(client: PGlite): Promise<number> {
  const { rows } = await client.query<{ b: number }>(
    "SELECT pg_total_relation_size('churn')::int AS b"
  );
  return rows[0].b;
}

// About 20 MB of incompressible rows per call.
async function writeRows(client: PGlite): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await client.query(
      "INSERT INTO churn (body) SELECT (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 60)) || g FROM generate_series(1, 100) g"
    );
  }
}

describe("in-memory PGlite settings", () => {
  it("keeps PGlite's start params and adds the smaller settings", async () => {
    const client = open().getConnection();
    expect(await setting(client, "search_path")).toBe("public");
    expect(await setting(client, "max_worker_processes")).toBe("0");
    expect(await setting(client, "shared_buffers")).toBe("16MB");
    expect(await setting(client, "max_wal_size")).toBe("32MB");
    expect(await setting(client, "wal_level")).toBe("minimal");
    expect(await setting(client, "full_page_writes")).toBe("off");
  });

  it("runs the plugin migrations", async () => {
    const manager = open();
    const adapter = new PgliteDatabaseAdapter(crypto.randomUUID() as UUID, manager);
    await adapter.init();
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
    migrations.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrations.runAllPluginMigrations();
    expect(await adapter.isReady()).toBe(true);
    const { rows } = await manager
      .getConnection()
      .query<{ n: number }>("SELECT count(*)::int AS n FROM memories");
    expect(rows[0].n).toBe(0);
  });

  it("lets the environment override a setting", async () => {
    process.env[MEMORY_SETTINGS_ENV] = "shared_buffers=24MB, max_wal_size=64MB";
    const client = open().getConnection();
    expect(await setting(client, "shared_buffers")).toBe("24MB");
    expect(await setting(client, "max_wal_size")).toBe("64MB");
    expect(await setting(client, "min_wal_size")).toBe("32MB");
  });

  it("rejects a malformed override and leaves other databases alone", () => {
    process.env[MEMORY_SETTINGS_ENV] = "shared_buffers 24MB";
    expect(() => new PGliteClientManager({ dataDir: "memory://" })).toThrow(MEMORY_SETTINGS_ENV);
    expect(withMemorySettings({ dataDir: "/var/data/pglite" })).toEqual({
      dataDir: "/var/data/pglite",
    });
    expect(withMemorySettings({ dataDir: "memory://", startParams: ["--single"] })).toEqual({
      dataDir: "memory://",
      startParams: ["--single"],
    });
    expect(withMemorySettings({ dataDir: "memory://" }, {}).startParams?.slice(0, 4)).toEqual(
      PGlite.defaultStartParams.slice(0, 4)
    );
  });

  it("frees WAL and reuses deleted rows after maintenance", async () => {
    const manager = open();
    const client = manager.getConnection();
    await client.exec(
      "CREATE TABLE churn (id serial PRIMARY KEY, body text NOT NULL); ALTER TABLE churn ALTER COLUMN body SET STORAGE EXTERNAL"
    );
    expect(await manager.runMemoryMaintenance()).toBe(false);
    let maxSegments = 0;
    for (let round = 0; round < 4; round++) {
      await writeRows(client);
      // A retention sweep: delete half of the rows.
      await client.exec("DELETE FROM churn WHERE id % 2 = 0");
      expect(await manager.runMemoryMaintenance()).toBe(true);
      maxSegments = Math.max(maxSegments, await walSegments(client));
    }
    // About 80 MB of WAL was written; two 16 MB segments are kept.
    expect(maxSegments).toBeLessThanOrEqual(2);
    // Without VACUUM the table would keep all four rounds, about 80 MB.
    expect(await tableBytes(client)).toBeLessThan(60 * 1024 * 1024);
    expect(await manager.runMemoryMaintenance()).toBe(false);
  });
});
