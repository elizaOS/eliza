/**
 * Repair Drizzle journal entries after local migration file renames.
 *
 * Why this exists:
 * - Drizzle reads migration filenames from packages/db/migrations/meta/_journal.json
 * - PR #403 renumbered migration files 0043-0053 to remove a duplicate 0043
 * - The database tracks applied migrations by hash + created_at in __drizzle_migrations
 * - Fresh DBs / CI still fail if the journal points at old filenames that no longer exist
 *
 * This helper rewrites the affected journal tags so the repo's on-disk journal matches
 * the current migration filenames.
 *
 * Usage:
 *   bun run packages/scripts/repair-drizzle-journal.ts
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

const JOURNAL_PATH = path.join(process.cwd(), "packages/db/migrations/meta/_journal.json");
const MIGRATIONS_DIR = path.dirname(path.dirname(JOURNAL_PATH));

// idx 43 intentionally maps back to 0043. The duplicate 0043 was introduced
// later in the journal history, so repairing a stale journal can look like a
// backwards rename even though the on-disk filenames are now sequential again.
const TAG_RENAMES = new Map<number, string>([
  [42, "0044_seed_chain_data_pricing"],
  [43, "0043_add_missing_referral_context_columns"],
  [44, "0045_add_whatsapp_identity_columns"],
  [45, "0046_add_redeemable_earnings_breakdown_columns"],
  [46, "0047_docker_nodes"],
  [47, "0048_add_token_agent_linkage"],
  [48, "0049_elite_rumiko_fujikawa"],
  [49, "0050_repair_existing_user_identity_privy_claims"],
  [50, "0051_backfill_user_identities_from_users"],
]);

async function main() {
  const migrationFiles = await readdir(MIGRATIONS_DIR);
  const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as Journal;

  let changed = 0;
  for (const entry of journal.entries) {
    const nextTag =
      TAG_RENAMES.get(entry.idx) ??
      (entry.idx === 51 ? resolveTagByPrefix(migrationFiles, "0052_") : undefined) ??
      (entry.idx === 52 ? resolveTagByPrefix(migrationFiles, "0053_") : undefined);
    if (!nextTag || entry.tag === nextTag) continue;

    console.log(`idx ${entry.idx}: ${entry.tag} -> ${nextTag}`);
    entry.tag = nextTag;
    changed++;
  }

  if (changed === 0) {
    console.log("Drizzle journal already matches the current migration filenames.");
    return;
  }

  await writeFile(JOURNAL_PATH, `${JSON.stringify(journal, null, 2)}\n`);
  console.log(`Updated ${JOURNAL_PATH} (${changed} entries repaired).`);
}

function resolveTagByPrefix(files: string[], prefix: string): string | undefined {
  const match = files.find((file) => file.startsWith(prefix) && file.endsWith(".sql"));
  return match?.replace(/\.sql$/, "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
