/**
 * Installs the database-enforced append-only guard for the identity claim
 * journal after runtime schema migration has materialized its table.
 */

import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "./types";

function rows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value === "object" && value !== null) {
    const resultRows = (value as { rows?: unknown }).rows;
    if (Array.isArray(resultRows)) return resultRows as Record<string, unknown>[];
  }
  return [];
}

/** Install or refresh the trigger that rejects journal UPDATE and DELETE. */
export async function applyIdentityClaimJournalGuard(db: DrizzleDatabase): Promise<boolean> {
  const present = await db.execute(sql`
    SELECT 1 AS present
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'identity_claim_journal'
     LIMIT 1
  `);
  if (rows(present).length === 0) return false;

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION reject_identity_claim_journal_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'identity_claim_journal is append-only'
        USING ERRCODE = '55000';
    END;
    $$
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_claim_journal_append_only ON identity_claim_journal`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_claim_journal_append_only
    BEFORE UPDATE OR DELETE ON identity_claim_journal
    FOR EACH ROW EXECUTE FUNCTION reject_identity_claim_journal_mutation()
  `);
  return true;
}
