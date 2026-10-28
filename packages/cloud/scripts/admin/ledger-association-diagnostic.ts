/** Diagnostic observations only; never validates, repairs, or admits a ledger. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuditQueryClient } from "./audit-production-railway-database-authority";
import {
  type AppliedMigration,
  createdAtValue,
  type Migration,
} from "./canonical-migration-ledger";

export function describeLedgerAssociations(
  rows: AppliedMigration[],
  migrations: Migration[],
) {
  const uniqueTag = (matches: Migration[]) =>
    matches.length === 1 &&
    migrations.filter((m) => m.entry.tag === matches[0].entry.tag).length === 1
      ? matches[0].entry.tag
      : null;
  const observed = new Set<string>();
  let previous = -1;
  let recognizedHashOrder = true;
  let unknownHashCount = 0;
  let ambiguousHashCount = 0;
  const associations = rows.map((row) => {
    const timestampMatches = migrations.filter(
      (m) => m.entry.when === createdAtValue(row),
    );
    const hashMatches = migrations.filter((m) => m.hash === row.hash);
    const hashTag = uniqueTag(hashMatches);
    if (!hashMatches.length) unknownHashCount++;
    else if (!hashTag) ambiguousHashCount++;
    if (hashTag) {
      observed.add(hashTag);
      const index = migrations.findIndex((m) => m.entry.tag === hashTag);
      if (index <= previous) recognizedHashOrder = false;
      previous = index;
    }
    return {
      timestampTag: uniqueTag(timestampMatches),
      hashTag,
      hashStatus: hashTag
        ? "unique"
        : hashMatches.length
          ? "ambiguous"
          : "none",
    };
  });
  return {
    purpose: "diagnostic_only",
    associations,
    unknownHashCount,
    ambiguousHashCount,
    recognizedHashOrder,
    unobservedCanonicalTags: migrations
      .filter((m) => !observed.has(m.entry.tag))
      .map((m) => m.entry.tag),
  };
}

export async function inspectLedgerAssociations(
  client: AuditQueryClient,
  migrations: Migration[],
) {
  const rows = await client.query<AppliedMigration>(
    "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC LIMIT 10001",
  );
  if (rows.rows.length > 10000)
    throw new Error("ledger_diagnostic_bound_exceeded");
  return describeLedgerAssociations(rows.rows, migrations);
}

export async function inspectGmailReceiptCatalog(
  client: AuditQueryClient,
  migrations: Migration[],
) {
  const matches = migrations.filter(
    (m) => m.entry.tag === "0509_managed_gmail_operation_receipts",
  );
  if (matches.length !== 1) throw new Error("gmail_source_guard");
  const sql = await readFile(
    new URL(
      "../../shared/src/db/migrations/0509_managed_gmail_operation_receipts.sql",
      import.meta.url,
    ),
    "utf8",
  );
  if (createHash("sha256").update(sql).digest("hex") !== matches[0].hash)
    throw new Error("gmail_source_guard");
  const body = sql.match(
    /RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/,
  )?.[1];
  if (!body) throw new Error("gmail_source_guard");
  const result = await client.query<Record<string, boolean>>(
    `SELECT
    to_regclass('public.managed_gmail_operation_receipts') IS NOT NULL AS "tablePresent",
    EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.managed_gmail_operation_receipts') AND relkind='r') AS "ordinaryTable",
    to_regprocedure('public.guard_managed_gmail_operation_receipt()') IS NOT NULL AS "functionPresent",
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure('public.guard_managed_gmail_operation_receipt()')
      AND p.prosrc=$1 AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype
      AND NOT p.prosecdef AND p.provolatile='v' AND p.proconfig IS NULL) AS "functionDefinitionMatches",
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.managed_gmail_operation_receipts')
      AND tgname='managed_gmail_operation_receipt_guard' AND NOT tgisinternal) AS "triggerPresent",
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.managed_gmail_operation_receipts')
      AND tgname='managed_gmail_operation_receipt_guard' AND NOT tgisinternal
      AND tgfoid=to_regprocedure('public.guard_managed_gmail_operation_receipt()')
      AND tgtype=19 AND tgenabled='O' AND tgnargs=0 AND tgqual IS NULL
      AND tgattr=''::int2vector) AS "triggerDefinitionMatches"`,
    [body],
  );
  const row = result.rows[0];
  const safe: Record<string, boolean> = {};
  for (const key of [
    "tablePresent",
    "ordinaryTable",
    "functionPresent",
    "functionDefinitionMatches",
    "triggerPresent",
    "triggerDefinitionMatches",
  ]) {
    if (result.rows.length !== 1 || typeof row?.[key] !== "boolean")
      throw new Error("gmail_catalog_unavailable");
    safe[key] = row[key];
  }
  return safe;
}
