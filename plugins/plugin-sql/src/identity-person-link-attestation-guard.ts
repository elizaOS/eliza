/**
 * Installs schema-qualified append-only and truncate guards for authenticated
 * person-link evidence after its deployment schema is materialized.
 */
import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "./types";

function rows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value !== "object" || value === null) return [];
  const resultRows = (value as { rows?: unknown }).rows;
  return Array.isArray(resultRows) ? (resultRows as Record<string, unknown>[]) : [];
}

/** Install or refresh mutation and truncate guards in the visible schema. */
export async function applyIdentityPersonLinkAttestationGuard(
  db: DrizzleDatabase
): Promise<boolean> {
  const present = await db.execute(sql`
    SELECT n.nspname AS schema_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'identity_person_link_attestations'
       AND c.relkind IN ('r', 'p')
       AND pg_catalog.pg_table_is_visible(c.oid)
     ORDER BY CASE WHEN n.nspname = current_schema() THEN 0 ELSE 1 END, n.nspname
     LIMIT 1
  `);
  const schemaName = rows(present)[0]?.schema_name;
  if (typeof schemaName !== "string" || schemaName.length === 0) return false;

  const schema = sql.identifier(schemaName);
  const table = sql`${schema}.${sql.identifier("identity_person_link_attestations")}`;
  const rejectMutation = sql`${schema}.${sql.identifier("reject_identity_person_link_attestation_mutation")}`;
  const rejectTruncate = sql`${schema}.${sql.identifier("reject_identity_person_link_attestation_truncate")}`;
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${rejectMutation}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'identity_person_link_attestations is append-only'
        USING ERRCODE = '55000';
    END;
    $$
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${rejectTruncate}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'identity_person_link_attestations cannot be truncated'
        USING ERRCODE = '55000';
    END;
    $$
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_person_link_attestation_append_only ON ${table}`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_person_link_attestation_append_only
    BEFORE UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${rejectMutation}()
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_person_link_attestation_no_truncate ON ${table}`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_person_link_attestation_no_truncate
    BEFORE TRUNCATE ON ${table}
    FOR EACH STATEMENT EXECUTE FUNCTION ${rejectTruncate}()
  `);
  return true;
}
