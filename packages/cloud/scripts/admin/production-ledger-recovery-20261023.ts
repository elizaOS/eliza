/**
 * One reviewed production migration-ledger recovery (October 23, 2026).
 *
 * Observed production state (read-only audit run 40031697986):
 * - ledger rows 1-370 are the canonical prefix;
 * - row 371 carries 0509's hash at 0387's journal time, row 372 carries 0535's
 *   hash at 0388's time (both Gmail migrations took effect out of order);
 * - row 373 carries a hash that matches no committed migration at 0389's time;
 * - 0536, 0537, 0540 and 0542 are already effective in the schema.
 *
 * The generated SQL runs in one transaction: it refuses any other ledger
 * shape, archives rows 371-373, applies the remaining canonical migrations in
 * journal order and writes canonical receipts for every journal entry. A
 * superseded intermediate CHECK (one a later pending migration redefines) is
 * created as a `CHECK (true) NOT VALID` placeholder, because historical rows
 * written by the out-of-order migrations cannot satisfy the intermediate
 * shape. The placeholder is visible only inside the transaction; every final
 * CHECK is added and validated as written, and the transaction aborts if a
 * placeholder survives.
 *
 * Usage: bun --no-env-file packages/cloud/scripts/admin/production-ledger-recovery-20261023.ts > recovery.sql
 */
import {
  type Migration,
  loadCanonicalMigrations,
} from "./canonical-migration-ledger";

export const REVIEWED_PREFIX_LENGTH = 370;
export const REVIEWED_ANOMALOUS_ROWS = [
  { id: 371, tag: "0509_managed_gmail_operation_receipts" },
  { id: 372, tag: "0535_managed_gmail_read_state_operations" },
  {
    id: 373,
    hash: "a465de981b9ebd4f0f4c0e60c594c825f3b0110b28fdf64340b8b1ef5c2108a0",
  },
] as const;
export const ALREADY_EFFECTIVE_TAGS = new Set([
  "0509_managed_gmail_operation_receipts",
  "0535_managed_gmail_read_state_operations",
  "0536_rooms_connector_server_id",
  "0537_relationships_extraction_evidence",
  "0540_embeddings_space_nonce_dim2048",
  "0542_subscription_grant_codes",
]);

const ADD_CHECK = /ADD\s+CONSTRAINT\s+"?([a-z0-9_]+)"?\s+CHECK\s*\(/gi;

const BREAKPOINT = "\n--> statement-breakpoint\n";

function migrationSql(migration: Migration): string {
  return migration.statements.join(BREAKPOINT);
}

function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function matchingParen(sql: string, open: number): number {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'") {
      index = sql.indexOf("'", index + 1);
      if (index === -1) throw Error("unterminated_literal");
    } else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw Error("unbalanced_check");
}

/** Replaces superseded intermediate CHECK bodies; final definitions are untouched. */
export function placeholderSupersededChecks(
  pending: Migration[],
): Map<string, string> {
  const lastAdd = new Map<string, string>();
  for (const migration of pending) {
    for (const match of stripLineComments(migrationSql(migration)).matchAll(
      ADD_CHECK,
    ))
      lastAdd.set(match[1], migration.entry.tag);
  }
  const rewritten = new Map<string, string>();
  for (const migration of pending) {
    const source = migrationSql(migration);
    let output = "";
    let cursor = 0;
    for (const match of source.matchAll(ADD_CHECK)) {
      const start = match.index ?? 0;
      const lineStart = source.lastIndexOf("\n", start) + 1;
      if (source.slice(lineStart, start).includes("--")) continue;
      if (lastAdd.get(match[1]) === migration.entry.tag) continue;
      const open = start + match[0].length - 1;
      const close = matchingParen(source, open);
      output += `${source.slice(cursor, open)}(true) NOT VALID`;
      cursor = close + 1;
    }
    rewritten.set(migration.entry.tag, output + source.slice(cursor));
  }
  return rewritten;
}

export function buildRecoverySql(migrations: Migration[]): string {
  const byTag = new Map(migrations.map((m) => [m.entry.tag, m]));
  const anomalous = REVIEWED_ANOMALOUS_ROWS.map((row) => {
    const hash = "tag" in row ? byTag.get(row.tag)?.hash : row.hash;
    if (!hash)
      throw Error(
        `missing_reviewed_migration:${"tag" in row ? row.tag : row.id}`,
      );
    return `(id=${row.id} AND hash='${hash}')`;
  }).join(" OR ");
  const tail = migrations.slice(REVIEWED_PREFIX_LENGTH);
  const pending = tail.filter((m) => !ALREADY_EFFECTIVE_TAGS.has(m.entry.tag));
  const executable = placeholderSupersededChecks(pending);
  const lines = [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL lock_timeout = '10s';",
    "SET LOCAL statement_timeout = '300s';",
    "LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE;",
    `DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> ${REVIEWED_PREFIX_LENGTH + REVIEWED_ANOMALOUS_ROWS.length}
     OR (SELECT max(id) FROM drizzle.__drizzle_migrations) <> ${REVIEWED_PREFIX_LENGTH + REVIEWED_ANOMALOUS_ROWS.length}
     OR (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE ${anomalous}) <> ${REVIEWED_ANOMALOUS_ROWS.length} THEN
    RAISE EXCEPTION 'ledger_shape_mismatch: production ledger is not the reviewed 373-row state';
  END IF;
END $$;`,
    `CREATE TABLE drizzle.__drizzle_migrations_retired_20261023 AS SELECT *, now() AS retired_at FROM drizzle.__drizzle_migrations WHERE ${anomalous};`,
    `DELETE FROM drizzle.__drizzle_migrations WHERE ${anomalous};`,
    `SELECT setval(pg_get_serial_sequence('drizzle.__drizzle_migrations','id'), ${REVIEWED_PREFIX_LENGTH}, true);`,
  ];
  for (const migration of tail) {
    const tag = migration.entry.tag;
    if (ALREADY_EFFECTIVE_TAGS.has(tag)) {
      lines.push(`-- already effective in production: ${tag}`);
    } else {
      const sql = executable.get(tag) ?? migrationSql(migration);
      lines.push(`-- apply ${tag}`);
      lines.push(
        `${sql
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter(Boolean)
          .join("\n;\n")}\n;`,
      );
    }
    lines.push(
      `INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('${migration.hash}', ${migration.entry.when});`,
    );
  }
  lines.push(`DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> ${migrations.length} THEN RAISE EXCEPTION 'ledger_count_mismatch after repair'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='c' AND pg_get_constraintdef(oid) ~ '^CHECK \\(true\\)') THEN RAISE EXCEPTION 'placeholder_constraint_survived'; END IF;
END $$;`);
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  process.stdout.write(buildRecoverySql(await loadCanonicalMigrations()));
}
