/**
 * Migration Audit Script
 *
 * WHY THIS EXISTS:
 * Drizzle ORM tracks migrations via a journal file (_journal.json) and the
 * __drizzle_migrations table in the database. When migrations are created
 * manually (outside of db:generate) or the journal gets out of sync, it becomes
 * unclear which migrations have actually been applied to production.
 *
 * This script provides visibility into:
 * 1. Migration files on disk vs what's tracked in the journal
 * 2. Duplicate migration numbers (common when mixing manual + auto-generated)
 * 3. Missing migration numbers (gaps in sequence)
 * 4. What's actually applied in the database (when connected)
 *
 * Use this script before and after migration consolidation to verify state.
 *
 * Usage: DATABASE_URL=... bun run packages/scripts/audit-migrations.ts
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface DrizzleMigration {
  id: number;
  hash: string;
  created_at: string;
}

async function getJournalEntries(): Promise<Journal> {
  const journalPath = path.join(process.cwd(), "packages/db/migrations/meta/_journal.json");
  const content = await readFile(journalPath, "utf-8");
  return JSON.parse(content) as Journal;
}

async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = path.join(process.cwd(), "packages/db/migrations");
  const files = await readdir(migrationsDir);
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => {
      const numA = parseInt(a.split("_")[0] ?? "0", 10);
      const numB = parseInt(b.split("_")[0] ?? "0", 10);
      return numA - numB;
    });
}

async function getAppliedMigrations(client: pg.Client): Promise<DrizzleMigration[]> {
  const result = await client.query<DrizzleMigration>(
    'SELECT * FROM "__drizzle_migrations" ORDER BY id',
  );
  return result.rows;
}

async function main() {
  console.log("\n=== Migration Audit Report ===\n");

  const journal = await getJournalEntries();
  const migrationFiles = await getMigrationFiles();

  console.log("📁 MIGRATION FILES:");
  console.log(`   Total SQL files: ${migrationFiles.length}`);

  const filesByNumber = new Map<string, string[]>();
  for (const file of migrationFiles) {
    const num = file.split("_")[0] ?? "";
    const existing = filesByNumber.get(num) ?? [];
    existing.push(file);
    filesByNumber.set(num, existing);
  }

  const duplicates = Array.from(filesByNumber.entries()).filter(([, files]) => files.length > 1);
  if (duplicates.length > 0) {
    console.log("\n   ⚠️  DUPLICATE MIGRATION NUMBERS:");
    for (const [num, files] of duplicates) {
      console.log(`   ${num}:`);
      for (const file of files) {
        console.log(`     - ${file}`);
      }
    }
  }

  const allNumbers = Array.from(filesByNumber.keys())
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 0; i < allNumbers.length - 1; i++) {
    const current = allNumbers[i]!;
    const next = allNumbers[i + 1]!;
    for (let j = current + 1; j < next; j++) {
      gaps.push(j);
    }
  }

  if (gaps.length > 0) {
    console.log(`\n   ⚠️  MISSING MIGRATION NUMBERS: ${gaps.join(", ")}`);
  }

  console.log("\n📋 JOURNAL STATE:");
  console.log(`   Tracked migrations: ${journal.entries.length}`);
  console.log("   Entries:");
  for (const entry of journal.entries) {
    console.log(`     ${entry.idx}: ${entry.tag}`);
  }

  const trackedFiles = new Set(journal.entries.map((e) => `${e.tag}.sql`));
  const untrackedFiles = migrationFiles.filter((f) => !trackedFiles.has(f));

  if (untrackedFiles.length > 0) {
    console.log(`\n   ⚠️  UNTRACKED FILES (${untrackedFiles.length}):`);
    for (const file of untrackedFiles) {
      console.log(`     - ${file}`);
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("\n📊 DATABASE STATE:");
    console.log("   ⚠️  DATABASE_URL not set - skipping database check");
    console.log("   Set DATABASE_URL to check applied migrations");
    return;
  }

  console.log("\n📊 DATABASE STATE:");
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();

    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = '__drizzle_migrations'
      )
    `);

    if (!tableCheck.rows[0]?.exists) {
      console.log("   ⚠️  __drizzle_migrations table does not exist");
      console.log("   This database has never had migrations applied via Drizzle");
      return;
    }

    const appliedMigrations = await getAppliedMigrations(client);
    console.log(`   Applied migrations: ${appliedMigrations.length}`);
    console.log("   Entries:");
    for (const migration of appliedMigrations) {
      console.log(`     ${migration.id}: ${migration.hash} (${migration.created_at})`);
    }

    console.log("\n📈 COMPARISON:");
    console.log(`   Journal entries:     ${journal.entries.length}`);
    console.log(`   Applied in DB:       ${appliedMigrations.length}`);
    console.log(`   SQL files on disk:   ${migrationFiles.length}`);

    if (journal.entries.length !== appliedMigrations.length) {
      console.log("\n   ⚠️  MISMATCH between journal entries and applied migrations!");
    }
  } catch (error) {
    console.log(`   ❌ Error connecting to database: ${error}`);
  } finally {
    await client.end();
  }

  console.log("\n=== Audit Complete ===\n");
}

main();
