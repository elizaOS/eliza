/** Read-only catalog probe for the two source-verified 0387 variants. Never repairs a ledger. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuditQueryClient } from "./audit-production-railway-database-authority";
import type { Migration } from "./canonical-migration-ledger";

import {
  inspectGmailReceiptCatalog,
  inspectLedgerAssociations,
} from "./ledger-association-diagnostic";

const TAG = "0387_agent_compute_funding";
const HASHES = {
  historical:
    "34c9dd1817deb2fbc3fde76f30904b76e98e605fbeb3b3524593ae649c527a3b",
  canonical: "0138969b1e4d1a7cfe93fd0af5c5b25a8f8045ef89b6e42c73467fdb2a9d2acf",
} as const;
type Variant = keyof typeof HASHES;
interface SchemaMatch {
  columns: Record<string, boolean>;
  constraints: Record<string, boolean>;
  indexes: Record<string, boolean>;
  noUnexpectedColumns: boolean;
  noUnexpectedConstraints: boolean;
  noUnexpectedIndexes: boolean;
}
export interface Funding0387Probe {
  variant: Variant | "unknown" | "unavailable";
  reason:
    | "source_guard"
    | "fixture_guard"
    | "ledger_row_count"
    | "unknown_hash"
    | null;
  relation?: {
    present: boolean;
    kind:
      | "table"
      | "partitioned_table"
      | "view"
      | "materialized_view"
      | "foreign_table"
      | "other"
      | "absent";
  };
  hashAssociation?: {
    status: "unique" | "none" | "ambiguous";
    canonicalTag: string | null;
  };
  ledgerAssociations?: Awaited<ReturnType<typeof inspectLedgerAssociations>>;
  gmailReceiptCatalog?: Awaited<ReturnType<typeof inspectGmailReceiptCatalog>>;
  schemaPurpose?: "diagnostic_only";
  schemaMatches: Record<Variant, SchemaMatch> | null;
}

// Definitions/defaults stay inside PostgreSQL comparisons. Only booleans and
// names supplied by the reviewed fixture leave the query, never stored text.
const SCHEMA_QUERY = `WITH
 columns_expected AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(name text, type text, "notNull" boolean, "defaultExpression" text)),
 constraints_expected AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS e(name text, definition text, validated boolean)),
 indexes_expected AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS e(name text, definition text, valid boolean, ready boolean, "unique" boolean)),
 relation AS (SELECT to_regclass('public.agent_compute_funding') AS oid)
SELECT
 (SELECT jsonb_object_agg(e.name, EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=(SELECT oid FROM relation) AND a.attname=e.name AND a.attnum>0 AND NOT a.attisdropped
  AND format_type(a.atttypid,a.atttypmod)=e.type AND a.attnotnull=e."notNull" AND a.attidentity='' AND a.attgenerated=''
  AND pg_get_expr(d.adbin,d.adrelid) IS NOT DISTINCT FROM e."defaultExpression")) FROM columns_expected e) AS columns,
 (SELECT jsonb_object_agg(e.name, EXISTS(SELECT 1 FROM pg_constraint c
  WHERE c.conrelid=(SELECT oid FROM relation) AND c.conname=e.name AND pg_get_constraintdef(c.oid)=e.definition AND c.convalidated=e.validated)) FROM constraints_expected e) AS constraints,
 (SELECT jsonb_object_agg(e.name, EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE i.indrelid=(SELECT oid FROM relation) AND c.relname=e.name AND pg_get_indexdef(i.indexrelid)=e.definition
  AND i.indisvalid=e.valid AND i.indisready=e.ready AND i.indisunique=e."unique")) FROM indexes_expected e) AS indexes,
 NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=(SELECT oid FROM relation) AND a.attnum>0 AND NOT a.attisdropped AND a.attname NOT IN(SELECT name FROM columns_expected)) AS "noUnexpectedColumns",
 NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=(SELECT oid FROM relation) AND c.conname NOT IN(SELECT name FROM constraints_expected)) AS "noUnexpectedConstraints",
 NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=(SELECT oid FROM relation) AND c.relname NOT IN(SELECT name FROM indexes_expected)) AS "noUnexpectedIndexes"`;

export async function probeFunding0387(
  client: AuditQueryClient,
  migrations: Migration[],
): Promise<Funding0387Probe> {
  try {
    const matching = migrations.filter((m) => m.entry.tag === TAG);
    if (matching.length !== 1 || matching[0].hash !== HASHES.canonical)
      return {
        variant: "unknown",
        reason: "source_guard",
        schemaMatches: null,
      };
    const historical = await readFile(
      new URL(
        "./fixtures/0387-agent-compute-funding-historical.sql",
        import.meta.url,
      ),
    );
    if (
      createHash("sha256").update(historical).digest("hex") !==
      HASHES.historical
    )
      return {
        variant: "unknown",
        reason: "fixture_guard",
        schemaMatches: null,
      };
    const ledger = await client.query<{ hash: string }>(
      "SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1",
      [matching[0].entry.when],
    );
    if (ledger.rows.length !== 1)
      return {
        variant: "unknown",
        reason: "ledger_row_count",
        schemaMatches: null,
      };
    const variant = (Object.keys(HASHES) as Variant[]).find(
      (key) => HASHES[key] === ledger.rows[0].hash,
    );
    // An unknown ledger hash does not prevent read-only catalog observation.
    // These flags cannot validate the ledger or authorize a migration plan.
    const candidates = migrations.filter(
      (migration) => migration.hash === ledger.rows[0].hash,
    );
    const unique =
      candidates.length === 1 &&
      migrations.filter(
        (migration) => migration.entry.tag === candidates[0].entry.tag,
      ).length === 1;
    const hashAssociation = {
      status: unique
        ? ("unique" as const)
        : candidates.length === 0
          ? ("none" as const)
          : ("ambiguous" as const),
      canonicalTag: unique ? candidates[0].entry.tag : null,
    };
    const relationResult = await client.query<{
      present: boolean;
      kind: string;
    }>(`
      SELECT c.oid IS NOT NULL AS present,
        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
          WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
          WHEN 'f' THEN 'foreign_table' ELSE CASE WHEN c.oid IS NULL THEN 'absent' ELSE 'other' END END AS kind
      FROM (SELECT to_regclass('public.agent_compute_funding') AS oid) r
      LEFT JOIN pg_class c ON c.oid=r.oid`);
    const relation = relationResult.rows[0];
    const kinds = [
      "table",
      "partitioned_table",
      "view",
      "materialized_view",
      "foreign_table",
      "other",
      "absent",
    ] as const;
    if (
      relationResult.rows.length !== 1 ||
      typeof relation?.present !== "boolean" ||
      !kinds.some((kind) => kind === relation.kind)
    )
      throw new Error("probe_result_unavailable");
    const expected = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/0387-agent-compute-funding-schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const schemaMatches = {} as Record<Variant, SchemaMatch>;
    for (const key of Object.keys(HASHES) as Variant[]) {
      const fixture = expected[key];
      const result = await client.query<SchemaMatch>(SCHEMA_QUERY, [
        JSON.stringify(fixture.columns),
        JSON.stringify(fixture.constraints),
        JSON.stringify(fixture.indexes),
      ]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row)
        throw new Error("probe_result_unavailable");
      // Copy only allowlisted fixture names and actual boolean values.
      const safe = {} as SchemaMatch;
      for (const group of ["columns", "constraints", "indexes"] as const) {
        safe[group] = {};
        for (const entry of fixture[group]) {
          if (typeof row[group]?.[entry.name] !== "boolean")
            throw new Error("probe_result_unavailable");
          safe[group][entry.name] = row[group][entry.name];
        }
      }
      for (const field of [
        "noUnexpectedColumns",
        "noUnexpectedConstraints",
        "noUnexpectedIndexes",
      ] as const) {
        if (typeof row[field] !== "boolean")
          throw new Error("probe_result_unavailable");
        safe[field] = row[field];
      }
      schemaMatches[key] = safe;
    }
    const extra = !variant
      ? {
          ledgerAssociations: await inspectLedgerAssociations(
            client,
            migrations,
          ),
          gmailReceiptCatalog: await inspectGmailReceiptCatalog(
            client,
            migrations,
          ),
        }
      : {};
    return {
      ...extra,
      variant: variant ?? "unknown",
      reason: variant ? null : "unknown_hash",
      relation: {
        present: relation.present,
        kind: relation.kind as (typeof kinds)[number],
      },
      hashAssociation,
      schemaPurpose: "diagnostic_only",
      schemaMatches,
    };
  } catch {
    // error-policy:J1 never expose database errors, parameters or stored values.
    return { variant: "unavailable", reason: null, schemaMatches: null };
  }
}
