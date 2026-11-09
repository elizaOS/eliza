/**
 * Real PGlite: a database started from the pre-migrated snapshot records the
 * same schema hash the migrator computes, so a boot migrating the same plugins
 * runs no DDL; a schema that changed after the snapshot still migrates, and the
 * snapshot holds no agent rows.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgliteDatabaseAdapter } from "../pglite/adapter";
import { PGliteClientManager } from "../pglite/manager";
import { createMigratedSnapshot } from "../pglite/migrated-snapshot";
import {
  generateSnapshot,
  hashSnapshot,
} from "../runtime-migrator/drizzle-adapters/snapshot-generator";
import { schema as coreSchema } from "../schema";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const extraTable = pgTable("snapshot_test_extra", {
  id: uuid("id").primaryKey(),
  note: text("note"),
});
const plugins = [{ name: "@elizaos/plugin-sql", schema: coreSchema as Record<string, unknown> }];

async function openFromSnapshot(file: string) {
  const previous = process.env.PGLITE_INITDB_SNAPSHOT;
  process.env.PGLITE_INITDB_SNAPSHOT = file;
  try {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const adapter = new PgliteDatabaseAdapter(AGENT_ID, manager);
    await adapter.init();
    return { manager, adapter, client: manager.getConnection() };
  } finally {
    if (previous === undefined) delete process.env.PGLITE_INITDB_SNAPSHOT;
    else process.env.PGLITE_INITDB_SNAPSHOT = previous;
  }
}

async function recordedMigrations(client: ReturnType<PGliteClientManager["getConnection"]>) {
  const { rows } = await client.query<{ plugin_name: string; hash: string }>(
    "SELECT plugin_name, hash FROM migrations._migrations ORDER BY id"
  );
  return rows;
}

describe("PGlite pre-migrated snapshot", () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pglite-migrated-"));
    file = path.join(dir, "pglite-migrated.bin");
    writeFileSync(file, await createMigratedSnapshot(plugins));
  }, 300_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the hash the migrator computes, so the same schema runs no DDL", async () => {
    const { manager, adapter, client } = await openFromSnapshot(file);
    try {
      const before = await recordedMigrations(client);
      expect(before).toEqual([
        {
          plugin_name: "@elizaos/plugin-sql",
          hash: hashSnapshot(await generateSnapshot(coreSchema)),
        },
      ]);
      await adapter.runPluginMigrations(plugins, { verbose: false });
      // A skipped plugin records nothing new.
      expect(await recordedMigrations(client)).toEqual(before);
      // No agent rows: the boot creates its own agent.
      const agents = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM agents");
      expect(agents.rows[0]?.n).toBe(0);
      await adapter.ensureAgentExists({ id: AGENT_ID, name: "Snapshot" });
      expect((await adapter.getAgent(AGENT_ID))?.name).toBe("Snapshot");
    } finally {
      await manager.close();
    }
  }, 300_000);

  it("still migrates a schema that changed after the snapshot", async () => {
    const { manager, adapter, client } = await openFromSnapshot(file);
    try {
      const changed = [
        {
          name: "@elizaos/plugin-sql",
          schema: { ...coreSchema, extraTable } as Record<string, unknown>,
        },
      ];
      await adapter.runPluginMigrations(changed, { verbose: false });
      const rows = await recordedMigrations(client);
      expect(rows).toHaveLength(2);
      expect(rows[1]?.hash).toBe(
        hashSnapshot(await generateSnapshot({ ...coreSchema, extraTable }))
      );
      const table = await client.query<{ present: boolean }>(
        "SELECT to_regclass('public.snapshot_test_extra') IS NOT NULL AS present"
      );
      expect(table.rows[0]?.present).toBe(true);
    } finally {
      await manager.close();
    }
  }, 300_000);
});
