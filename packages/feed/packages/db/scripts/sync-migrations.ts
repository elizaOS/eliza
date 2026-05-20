/**
 * Sync migrations script to populate __drizzle_migrations table.
 *
 * This script is needed when the database schema was applied via db:push or
 * manual SQL, but the migrations tracking table wasn't updated. It reads
 * the _journal.json file and inserts records for all migrations, marking
 * them as already applied.
 *
 * Usage: DATABASE_URL="..." bun run packages/db/scripts/sync-migrations.ts
 *
 * Options:
 *   --dry-run    Show what would be inserted without making changes
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  // Read the journal file
  const journalPath = join(
    __dirname,
    '../drizzle/migrations/meta/_journal.json'
  );
  const journalContent = readFileSync(journalPath, 'utf-8');
  const journal: Journal = JSON.parse(journalContent);

  console.log(`Found ${journal.entries.length} migrations in journal:\n`);
  for (const entry of journal.entries) {
    console.log(`  [${entry.idx}] ${entry.tag}`);
  }
  console.log('');

  const sql = postgres(databaseUrl);

  try {
    // Ensure the drizzle schema and migrations table exist
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `;

    // Check existing migrations
    const existing = await sql`
      SELECT hash FROM drizzle.__drizzle_migrations
    `;
    const existingHashes = new Set(existing.map((r) => r.hash));

    console.log(`Found ${existingHashes.size} migrations already tracked\n`);

    // Insert missing migrations
    let inserted = 0;
    let skipped = 0;

    for (const entry of journal.entries) {
      // Drizzle uses the tag as the hash
      const hash = entry.tag;

      if (existingHashes.has(hash)) {
        console.log(`  SKIP: ${entry.tag} (already tracked)`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  WOULD INSERT: ${entry.tag} (created_at: ${entry.when})`);
      } else {
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${entry.when})
        `;
        console.log(`  INSERTED: ${entry.tag}`);
      }
      inserted++;
    }

    console.log('');
    console.log(`Summary:`);
    console.log(`  Skipped (already tracked): ${skipped}`);
    console.log(`  ${dryRun ? 'Would insert' : 'Inserted'}: ${inserted}`);

    if (!dryRun && inserted > 0) {
      console.log('\n✓ Migrations table synced successfully!');
      console.log('  You can now run: bun run db:migrate');
    } else if (dryRun && inserted > 0) {
      console.log('\nRun without --dry-run to apply changes.');
    } else {
      console.log('\n✓ Migrations table is already up to date!');
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
