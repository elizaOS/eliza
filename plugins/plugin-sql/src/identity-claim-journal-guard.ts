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
      IF TG_TABLE_NAME = 'identity_claim_journal'
         AND TG_OP = 'DELETE'
         AND NOT EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
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
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION retain_identity_claim_journal_evidence()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO identity_claim_retention_ledger (
        event_kind,
        prior_version,
        resulting_version
      )
      SELECT
        j.event_kind,
        j.prior_version,
        j.resulting_version
      FROM identity_claim_journal j
      WHERE j.agent_id = OLD.id;
      RETURN OLD;
    END;
    $$
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_claim_journal_retention_on_agent_delete ON agents`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_claim_journal_retention_on_agent_delete
    BEFORE DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION retain_identity_claim_journal_evidence()
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_claim_retention_ledger_append_only ON identity_claim_retention_ledger`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_claim_retention_ledger_append_only
    BEFORE UPDATE OR DELETE ON identity_claim_retention_ledger
    FOR EACH ROW EXECUTE FUNCTION reject_identity_claim_journal_mutation()
  `);
  return true;
}
