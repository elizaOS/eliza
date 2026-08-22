/**
 * Installs the database-enforced append-only guard for authenticated person-link
 * evidence after runtime migration has materialized the authority table.
 */
import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "./types";

function resultRows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];
  const rows = (value as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows : [];
}

/** Install or refresh the trigger that rejects attestation UPDATE and DELETE. */
export async function applyIdentityPersonLinkAttestationGuard(
  db: DrizzleDatabase
): Promise<boolean> {
  const present = await db.execute(sql`
    SELECT 1 AS present
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'identity_person_link_attestations'
     LIMIT 1
  `);
  if (resultRows(present).length === 0) return false;

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION reject_identity_person_link_attestation_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'identity_person_link_attestations is append-only'
        USING ERRCODE = '55000';
    END;
    $$
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_person_link_attestation_append_only ON identity_person_link_attestations`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_person_link_attestation_append_only
    BEFORE UPDATE OR DELETE ON identity_person_link_attestations
    FOR EACH ROW EXECUTE FUNCTION reject_identity_person_link_attestation_mutation()
  `);
  return true;
}
