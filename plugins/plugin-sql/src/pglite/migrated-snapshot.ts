/**
 * A pre-migrated, empty PGlite data directory for in-memory databases.
 *
 * An in-memory agent database starts empty on every boot, so every boot ran
 * the whole plugin schema migration again: about 270 DDL statements for the
 * core, scheduling and agent schemas, the extension installs and the
 * post-migration search objects. On a tablet that is most of the 4 s
 * `svc:startup-maintenance` boot phase.
 *
 * The mobile bundle build runs those migrations once, with the PGlite it
 * bundles, and writes the cluster beside the bundle as `pglite-migrated.bin`
 * (see initdb-snapshot.ts for how a boot picks it). The snapshot records each
 * plugin's schema hash in the migrator's own tables, so at boot the
 * RuntimeMigrator finds the hash it would compute and skips that plugin. A
 * snapshot that no longer matches a plugin's schema is not wrong, only slower:
 * the migrator diffs from the recorded snapshot and applies the difference, as
 * it does for any on-disk database. The snapshot holds no rows besides the
 * migrator's bookkeeping; the agent, its entity and room are created at boot.
 */
import type { UUID } from "@elizaos/core";
import { PgliteDatabaseAdapter } from "./adapter";
import { PGliteClientManager } from "./manager";

export { MIGRATED_SNAPSHOT_FILE } from "./initdb-snapshot";

/** A plugin schema as the runtime hands it to `runPluginMigrations`. */
export interface SnapshotPluginSchema {
  name: string;
  schema: Record<string, unknown>;
}

/** Only for the adapter constructor; the snapshot writes no agent rows. */
const SNAPSHOT_AGENT_ID = "00000000-0000-0000-0000-000000000000" as UUID;

/**
 * Migrates a fresh in-memory database (from the initdb snapshot when
 * `PGLITE_INITDB_SNAPSHOT` or the bundle provides one) for these plugins and
 * returns its data directory as a gzip tar, the form PGlite's `loadDataDir`
 * takes. Each plugin migrates under its own name, in the given order, exactly
 * as the runtime would migrate it.
 */
export async function createMigratedSnapshot(
  plugins: readonly SnapshotPluginSchema[]
): Promise<Uint8Array> {
  if (plugins.length === 0) throw new Error("createMigratedSnapshot needs at least one plugin");
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (names.has(plugin.name)) throw new Error(`Duplicate plugin schema: ${plugin.name}`);
    names.add(plugin.name);
  }
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  try {
    const adapter = new PgliteDatabaseAdapter(SNAPSHOT_AGENT_ID, manager);
    await adapter.init();
    await adapter.runPluginMigrations([...plugins], {
      verbose: false,
      force: false,
      dryRun: false,
    });
    const client = manager.getConnection();
    // Flush the WAL into the data files so the dump holds a clean cluster.
    await client.exec("CHECKPOINT");
    const dump = await client.dumpDataDir("gzip");
    return new Uint8Array(await dump.arrayBuffer());
  } finally {
    await manager.close();
  }
}
