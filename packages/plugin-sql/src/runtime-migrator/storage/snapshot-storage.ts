import { sql } from 'drizzle-orm';
import type { DrizzleDB, SchemaSnapshot } from '../types';

export class SnapshotStorage {
  constructor(private db: DrizzleDB) {}

  async saveSnapshot(pluginName: string, idx: number, snapshot: SchemaSnapshot): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO migrations._snapshots (plugin_name, idx, snapshot)
          VALUES (${pluginName}, ${idx}, ${JSON.stringify(snapshot)}::jsonb)
          ON CONFLICT (plugin_name, idx) 
          DO UPDATE SET 
            snapshot = EXCLUDED.snapshot,
            created_at = NOW()`
    );
  }

  async loadSnapshot(pluginName: string, idx: number): Promise<SchemaSnapshot | null> {
    const result = await this.db.execute(
      sql`SELECT snapshot 
          FROM migrations._snapshots 
          WHERE plugin_name = ${pluginName} AND idx = ${idx}`
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].snapshot as SchemaSnapshot;
  }

  async getLatestSnapshot(pluginName: string): Promise<SchemaSnapshot | null> {
    const result = await this.db.execute(
      sql`SELECT snapshot 
          FROM migrations._snapshots 
          WHERE plugin_name = ${pluginName}
          ORDER BY idx DESC
          LIMIT 1`
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].snapshot as SchemaSnapshot;
  }

  async getAllSnapshots(pluginName: string): Promise<SchemaSnapshot[]> {
    const result = await this.db.execute(
      sql`SELECT snapshot 
          FROM migrations._snapshots 
          WHERE plugin_name = ${pluginName}
          ORDER BY idx ASC`
    );

    return result.rows.map((row) => row.snapshot as SchemaSnapshot);
  }
}
