import { sql } from 'drizzle-orm';
import type { DrizzleDB } from '../types';

export class MigrationTracker {
  constructor(private db: DrizzleDB) {}

  async ensureSchema(): Promise<void> {
    await this.db.execute(sql`CREATE SCHEMA IF NOT EXISTS migrations`);
  }

  async ensureTables(): Promise<void> {
    // Ensure schema exists
    await this.ensureSchema();

    // Create migrations table (like Drizzle's __drizzle_migrations)
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS migrations._migrations (
        id SERIAL PRIMARY KEY,
        plugin_name TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);

    // Create journal table (replaces _journal.json)
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS migrations._journal (
        plugin_name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        dialect TEXT NOT NULL DEFAULT 'postgresql',
        entries JSONB NOT NULL DEFAULT '[]'
      )
    `);

    // Create snapshots table (replaces snapshot JSON files)
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS migrations._snapshots (
        id SERIAL PRIMARY KEY,
        plugin_name TEXT NOT NULL,
        idx INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(plugin_name, idx)
      )
    `);
  }

  async getLastMigration(pluginName: string): Promise<{
    id: number;
    hash: string;
    created_at: string;
  } | null> {
    const result = await this.db.execute(
      sql`SELECT id, hash, created_at 
          FROM migrations._migrations 
          WHERE plugin_name = ${pluginName} 
          ORDER BY created_at DESC 
          LIMIT 1`
    );
    return (result.rows[0] as any) || null;
  }

  async recordMigration(pluginName: string, hash: string, createdAt: number): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO migrations._migrations (plugin_name, hash, created_at) 
          VALUES (${pluginName}, ${hash}, ${createdAt})`
    );
  }
}
