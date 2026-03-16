import { sql } from "drizzle-orm";
import { getMysqlRow } from "../types";
import type { DrizzleDB } from "../types";

/**
 * MySQL migration tracker.
 * Uses table prefixes (_eliza_migrations, _eliza_journal, _eliza_snapshots)
 * instead of PostgreSQL's schema-based approach (migrations._migrations).
 */
export class MigrationTracker {
  constructor(private db: DrizzleDB) {}

  async ensureTables(): Promise<void> {
    // Create migrations tracking table
    await this.db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS _eliza_migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        plugin_name VARCHAR(255) NOT NULL,
        hash VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL
      )
    `));

    // Create journal table (replaces _journal.json)
    await this.db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS _eliza_journal (
        plugin_name VARCHAR(255) PRIMARY KEY,
        version VARCHAR(50) NOT NULL,
        dialect VARCHAR(50) NOT NULL DEFAULT 'mysql',
        entries JSON NOT NULL
      )
    `));

    // Create snapshots table (replaces snapshot JSON files)
    await this.db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS _eliza_snapshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        plugin_name VARCHAR(255) NOT NULL,
        idx INT NOT NULL,
        snapshot JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_plugin_idx (plugin_name, idx)
      )
    `));
  }

  async getLastMigration(pluginName: string): Promise<{
    id: number;
    hash: string;
    created_at: string;
  } | null> {
    const result = await this.db.execute(
      sql`SELECT id, hash, created_at
          FROM _eliza_migrations
          WHERE plugin_name = ${pluginName}
          ORDER BY created_at DESC
          LIMIT 1`
    );
    interface MigrationRow {
      id: number;
      hash: string;
      created_at: string;
    }
    return getMysqlRow<MigrationRow>(result) || null;
  }

  async recordMigration(pluginName: string, hash: string, createdAt: number): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO _eliza_migrations (plugin_name, hash, created_at)
          VALUES (${pluginName}, ${hash}, ${createdAt})`
    );
  }
}
