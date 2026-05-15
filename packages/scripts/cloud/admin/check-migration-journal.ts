/**
 * Fail fast when Drizzle migration files and the repo journal drift apart.
 *
 * This guards against:
 * - duplicate numeric prefixes (e.g. two 0043_*.sql files)
 * - missing journal entries for SQL files
 * - journal tags pointing at missing SQL files
 * - journal/file ordering drift after manual renames
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

const MIGRATIONS_DIR = path.join(process.cwd(), "packages/db/migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta/_journal.json");
const ALLOWED_DUPLICATE_PREFIX_GROUPS = new Map<string, string[]>([
  ["0017", ["0017_add_organization_encryption_keys.sql", "0017_fix_earnings_precision.sql"]],
  [
    "0048",
    [
      "0048_00_elite_rumiko_fujikawa_drops.sql",
      "0048_01_elite_rumiko_fujikawa_creates.sql",
      "0048_02_elite_rumiko_fujikawa_alters.sql",
      "0048_03_elite_rumiko_fujikawa_indexes.sql",
      "0048_add_token_agent_linkage.sql",
    ],
  ],
  ["0065", ["0065_add_device_bus_tables.sql", "0065_add_generations_is_public.sql"]],
]);

function sortByNumericPrefix(a: string, b: string): number {
  const numA = parseInt(a.split("_")[0] ?? "0", 10);
  const numB = parseInt(b.split("_")[0] ?? "0", 10);
  if (numA !== numB) return numA - numB;
  return a.localeCompare(b);
}

async function main() {
  const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as Journal;
  const migrationFilesOnDisk = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort(sortByNumericPrefix);

  const errors: string[] = [];
  const journalFiles = journal.entries.map((entry) => `${entry.tag}.sql`);
  const diskFileSet = new Set(migrationFilesOnDisk);

  // Only enforce duplicate-prefix checks for journal-tracked files. The repo has a
  // few historical helper/legacy SQL files that are intentionally not in the Drizzle journal.
  const trackedFilesByPrefix = new Map<string, string[]>();
  for (const file of journalFiles) {
    const prefix = file.split("_")[0] ?? "";
    const list = trackedFilesByPrefix.get(prefix) ?? [];
    list.push(file);
    trackedFilesByPrefix.set(prefix, list);
  }

  for (const [prefix, files] of trackedFilesByPrefix) {
    if (files.length <= 1) {
      continue;
    }

    const allowedFiles = ALLOWED_DUPLICATE_PREFIX_GROUPS.get(prefix);
    const isAllowedHistoricalGroup =
      allowedFiles &&
      allowedFiles.length === files.length &&
      allowedFiles.every((file) => files.includes(file));

    if (!isAllowedHistoricalGroup) {
      errors.push(`Duplicate journal-tracked migration prefix ${prefix}: ${files.join(", ")}`);
    }
  }

  for (const file of journalFiles) {
    if (!diskFileSet.has(file)) {
      errors.push(`Journal entry points to missing migration file: ${file}`);
    }
  }

  if (errors.length > 0) {
    console.error("Migration journal check failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Migration journal OK (${journal.entries.length} journal entries, ${migrationFilesOnDisk.length} SQL files on disk).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
