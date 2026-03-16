import { sql } from "drizzle-orm";
import { getMysqlRow, getMysqlRows } from "../types";
import type { DrizzleDB, SchemaSnapshot } from "../types";

export class SnapshotStorage {
  constructor(private db: DrizzleDB) {}

  async saveSnapshot(pluginName: string, idx: number, snapshot: SchemaSnapshot): Promise<void> {
    const snapshotJson = JSON.stringify(snapshot);
    await this.db.execute(
      sql`INSERT INTO _eliza_snapshots (plugin_name, idx, snapshot)
          VALUES (${pluginName}, ${idx}, CAST(${snapshotJson} AS JSON))
          ON DUPLICATE KEY UPDATE
            snapshot = VALUES(snapshot),
            created_at = CURRENT_TIMESTAMP`
    );
  }

  async loadSnapshot(pluginName: string, idx: number): Promise<SchemaSnapshot | null> {
    const result = await this.db.execute(
      sql`SELECT snapshot
          FROM _eliza_snapshots
          WHERE plugin_name = ${pluginName} AND idx = ${idx}`
    );

    const row = getMysqlRow<{ snapshot: SchemaSnapshot | string }>(result);
    if (!row) {
      return null;
    }

    // MySQL JSON columns may return a string or parsed object
    return typeof row.snapshot === "string"
      ? JSON.parse(row.snapshot)
      : row.snapshot;
  }

  async getLatestSnapshot(pluginName: string): Promise<SchemaSnapshot | null> {
    const result = await this.db.execute(
      sql`SELECT snapshot
          FROM _eliza_snapshots
          WHERE plugin_name = ${pluginName}
          ORDER BY idx DESC
          LIMIT 1`
    );

    const row = getMysqlRow<{ snapshot: SchemaSnapshot | string }>(result);
    if (!row) {
      return null;
    }

    return typeof row.snapshot === "string"
      ? JSON.parse(row.snapshot)
      : row.snapshot;
  }

  async getAllSnapshots(pluginName: string): Promise<SchemaSnapshot[]> {
    const result = await this.db.execute(
      sql`SELECT snapshot
          FROM _eliza_snapshots
          WHERE plugin_name = ${pluginName}
          ORDER BY idx ASC`
    );

    const rows = getMysqlRows<{ snapshot: SchemaSnapshot | string }>(result);
    return rows.map((row) =>
      typeof row.snapshot === "string"
        ? JSON.parse(row.snapshot)
        : row.snapshot
    );
  }
}
