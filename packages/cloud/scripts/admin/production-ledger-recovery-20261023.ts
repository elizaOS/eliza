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
 * The generated SQL runs in one transaction. Under the ledger lock and before
 * any mutation it refuses any ledger other than the exact reviewed rows (every
 * id, hash and created_at) and any schema in which an already-effective
 * migration's objects are missing or differ from the reviewed fingerprint. It
 * then archives rows 371-373, restarts the id sequence transactionally,
 * applies the remaining canonical migrations in journal order, writes
 * canonical receipts for every reviewed journal entry and verifies the
 * complete resulting ledger and sequence. A
 * superseded intermediate CHECK (one a later pending migration redefines) is
 * created as a `CHECK (true) NOT VALID` placeholder, because historical rows
 * written by the out-of-order migrations cannot satisfy the intermediate
 * shape. The placeholder is visible only inside the transaction; every final
 * CHECK is added and validated as written, and the transaction aborts if a
 * placeholder survives.
 *
 * Usage: bun --no-env-file packages/cloud/scripts/admin/production-ledger-recovery-20261023.ts > recovery.sql
 *        bun --no-env-file packages/cloud/scripts/admin/production-ledger-recovery-20261023.ts --fingerprint-query
 *          prints the read-only query behind the already-effective fingerprint.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  loadCanonicalMigrations,
  type Migration,
} from "./canonical-migration-ledger";

export const REVIEWED_PREFIX_LENGTH = 370;
/** Journal entries the recovery was reviewed against; later entries migrate normally. */
export const REVIEWED_JOURNAL_LENGTH = 519;
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

const EFFECT_TABLES = [
  "managed_gmail_operation_receipts",
  "subscription_grant_codes",
  "subscription_grants",
];
const EFFECT_COLUMNS = [
  ["rooms", "connector_server_id"],
  ["relationships", "extraction_evidence"],
  ["embeddings", "space_id"],
  ["embeddings", "write_nonce"],
  ["embeddings", "dim_2048"],
  ["organization_entitlements", "source_grant_id"],
  ["subscription_allowance_periods", "subscription_id"],
  ["subscription_allowance_periods", "subscription_revision"],
  ["subscription_allowance_periods", "promo_grant_id"],
];
const EFFECT_CONSTRAINTS = [
  "embedding_space_write_check",
  "organization_entitlements_source_grant_tenant_fk",
  "organization_entitlements_plan_state_check",
  "subscription_allowance_periods_promo_grant_tenant_fk",
  "subscription_allowance_periods_invoice_id_check",
];
const EFFECT_INDEXES = [
  "subscription_allowance_periods_promo_grant_period_idx",
];
const EFFECT_TRIGGERS = [
  "managed_gmail_operation_receipt_guard",
  "subscription_grants_immutable",
];
const EFFECT_FUNCTIONS = [
  "guard_managed_gmail_operation_receipt",
  "guard_subscription_grant_record",
];

const list = (values: string[]) => values.map((v) => `'${v}'`).join(",");

/**
 * Read-only catalog fingerprint of every object the already-effective
 * migrations create or change, as (kind, name, definition) rows.
 */
export const EFFECT_FINGERPRINT_SQL = `SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
    format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
      || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') AS definition
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND (c.relname IN (${list(EFFECT_TABLES)})
      OR (c.relname, a.attname) IN (${EFFECT_COLUMNS.map(([t, c]) => `('${t}','${c}')`).join(",")}))
UNION ALL
SELECT 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid) || ' validated:' || con.convalidated
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE con.contype <> 'n' AND (c.relname IN (${list(EFFECT_TABLES)}) OR con.conname IN (${list(EFFECT_CONSTRAINTS)}))
UNION ALL
SELECT 'index', i.relname, pg_get_indexdef(i.oid) || ' valid:' || x.indisvalid || ' ready:' || x.indisready
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
  WHERE t.relname IN (${list(EFFECT_TABLES)}) OR i.relname IN (${list(EFFECT_INDEXES)})
UNION ALL
SELECT 'trigger', c.relname || '.' || tg.tgname, pg_get_triggerdef(tg.oid) || ' enabled:' || tg.tgenabled::text
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE NOT tg.tgisinternal AND tg.tgname IN (${list(EFFECT_TRIGGERS)})
UNION ALL
SELECT 'function', p.proname, l.lanname || ' ' || format_type(p.prorettype, NULL) || ' md5:' || md5(p.prosrc)
    || ' args:' || pg_get_function_identity_arguments(p.oid)
    || ' security_definer:' || p.prosecdef || ' strict:' || p.proisstrict
    || ' volatility:' || p.provolatile::text || ' parallel:' || p.proparallel::text
    || ' config:' || COALESCE(p.proconfig::text, 'null')
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname IN (${list(EFFECT_FUNCTIONS)})`;

export interface EffectFingerprintRow {
  kind: string;
  name: string;
  definition: string;
}

export const EFFECT_FINGERPRINT_PATH = path.join(
  import.meta.dir,
  "fixtures/production-ledger-recovery-20261023-effects.json",
);

/** Reviewed fingerprint, captured from the canonical prefix plus the six out-of-order migrations. */
export function loadReviewedEffectFingerprint(): EffectFingerprintRow[] {
  return JSON.parse(readFileSync(EFFECT_FINGERPRINT_PATH, "utf8"));
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function ledgerValues(rows: { id: number; hash: string; when: number }[]) {
  return rows
    .map((row) => `(${row.id},${literal(row.hash)},${row.when}::bigint)`)
    .join(",\n    ");
}

/** Exact-set comparison of the whole ledger, by id, hash and created_at. */
function ledgerMismatch(rows: { id: number; hash: string; when: number }[]) {
  return `(SELECT count(*) FROM drizzle.__drizzle_migrations) <> ${rows.length}
     OR EXISTS (
  WITH expected(id, hash, created_at) AS (VALUES
    ${ledgerValues(rows)}),
  actual AS (SELECT id::int, hash, created_at::bigint FROM drizzle.__drizzle_migrations)
  (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  UNION ALL
  (SELECT * FROM expected EXCEPT SELECT * FROM actual))`;
}

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

export function buildRecoverySql(
  migrations: Migration[],
  effects: EffectFingerprintRow[],
): string {
  if (migrations.length < REVIEWED_JOURNAL_LENGTH)
    throw Error(`journal_shorter_than_reviewed:${migrations.length}`);
  if (effects.length === 0) throw Error("missing_reviewed_effect_fingerprint");
  const reviewed = migrations.slice(0, REVIEWED_JOURNAL_LENGTH);
  const byTag = new Map(reviewed.map((m) => [m.entry.tag, m]));
  const before = reviewed
    .slice(0, REVIEWED_PREFIX_LENGTH)
    .map((m, index) => ({ id: index + 1, hash: m.hash, when: m.entry.when }));
  REVIEWED_ANOMALOUS_ROWS.forEach((row, offset) => {
    const hash = "tag" in row ? byTag.get(row.tag)?.hash : row.hash;
    if (!hash)
      throw Error(
        `missing_reviewed_migration:${"tag" in row ? row.tag : row.id}`,
      );
    // Each anomalous row was written at the journal time of the canonical entry it displaced.
    const when = reviewed[REVIEWED_PREFIX_LENGTH + offset].entry.when;
    before.push({ id: row.id, hash, when });
  });
  const after = reviewed.map((m, index) => ({
    id: index + 1,
    hash: m.hash,
    when: m.entry.when,
  }));
  const tail = reviewed.slice(REVIEWED_PREFIX_LENGTH);
  const pending = tail.filter((m) => !ALREADY_EFFECTIVE_TAGS.has(m.entry.tag));
  const executable = placeholderSupersededChecks(pending);
  const effectValues = effects
    .map(
      (row) =>
        `(${literal(row.kind)},${literal(row.name)},${literal(row.definition)})`,
    )
    .join(",\n    ");
  const lines = [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "SET LOCAL lock_timeout = '10s';",
    "SET LOCAL statement_timeout = '300s';",
    "LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE;",
    `LOCK TABLE ${[...new Set([...EFFECT_TABLES, ...EFFECT_COLUMNS.map(([table]) => table)])].map((table) => `public.${table}`).join(", ")} IN ACCESS EXCLUSIVE MODE;`,
    `DO $$ BEGIN
  IF ${ledgerMismatch(before)} THEN
    RAISE EXCEPTION 'ledger_shape_mismatch: production ledger is not the reviewed ${before.length}-row state';
  END IF;
END $$;`,
    `DO $$ DECLARE mismatched text; BEGIN
  WITH expected(kind, name, definition) AS (VALUES
    ${effectValues}),
  actual AS (${EFFECT_FINGERPRINT_SQL}),
  differences AS (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected))
  SELECT string_agg(e.kind || ' ' || e.name, ', ' ORDER BY e.kind, e.name) INTO mismatched
    FROM differences e;
  IF mismatched IS NOT NULL THEN
    RAISE EXCEPTION 'already_effective_schema_mismatch: %', mismatched;
  END IF;
END $$;`,
    `CREATE TABLE drizzle.__drizzle_migrations_retired_20261023 AS SELECT *, now() AS retired_at FROM drizzle.__drizzle_migrations WHERE id > ${REVIEWED_PREFIX_LENGTH};`,
    `DELETE FROM drizzle.__drizzle_migrations WHERE id > ${REVIEWED_PREFIX_LENGTH};`,
    // setval is not transactional; a restart is, so a rollback restores the original sequence.
    `DO $$ DECLARE seq text := pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'); BEGIN
  IF seq IS NULL THEN RAISE EXCEPTION 'ledger_sequence_missing'; END IF;
  EXECUTE format('ALTER SEQUENCE %s RESTART WITH ${REVIEWED_PREFIX_LENGTH + 1}', seq);
END $$;`,
  ];
  for (const migration of tail) {
    const tag = migration.entry.tag;
    if (ALREADY_EFFECTIVE_TAGS.has(tag)) {
      lines.push(
        `-- already effective in production (fingerprint verified): ${tag}`,
      );
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
  lines.push(`DO $$ DECLARE seq text := pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id'); last_id bigint; called boolean; BEGIN
  IF ${ledgerMismatch(after)} THEN
    RAISE EXCEPTION 'ledger_mismatch_after_repair';
  END IF;
  EXECUTE format('SELECT last_value, is_called FROM %s', seq) INTO last_id, called;
  IF NOT called OR last_id < ${after.length} THEN RAISE EXCEPTION 'ledger_sequence_behind_after_repair'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='c' AND pg_get_constraintdef(oid) ~ '^CHECK \\(true\\)') THEN RAISE EXCEPTION 'placeholder_constraint_survived'; END IF;
END $$;`);
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  process.stdout.write(
    process.argv.includes("--fingerprint-query")
      ? `${EFFECT_FINGERPRINT_SQL}\nORDER BY 1, 2;\n`
      : buildRecoverySql(
          await loadCanonicalMigrations(),
          loadReviewedEffectFingerprint(),
        ),
  );
}
