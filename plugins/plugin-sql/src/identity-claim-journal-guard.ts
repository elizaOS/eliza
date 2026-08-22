/**
 * Installs schema-qualified append-only and lifecycle guards for identity claim
 * history after migration. The visible deployment schema is discovered from
 * PostgreSQL catalogs; no public-schema assumption is made.
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

async function findAuthoritySchema(db: DrizzleDatabase): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT journal_ns.nspname AS schema_name
      FROM pg_catalog.pg_class journal
      JOIN pg_catalog.pg_namespace journal_ns
        ON journal_ns.oid = journal.relnamespace
      JOIN pg_catalog.pg_class retention
        ON retention.relnamespace = journal.relnamespace
       AND retention.relname = 'identity_claim_retention_ledger'
       AND retention.relkind IN ('r', 'p')
      JOIN pg_catalog.pg_class agent
        ON agent.relnamespace = journal.relnamespace
       AND agent.relname = 'agents'
       AND agent.relkind IN ('r', 'p')
     WHERE journal.relname = 'identity_claim_journal'
       AND journal.relkind IN ('r', 'p')
       AND pg_catalog.pg_table_is_visible(journal.oid)
     ORDER BY CASE WHEN journal_ns.nspname = current_schema() THEN 0 ELSE 1 END,
              journal_ns.nspname
     LIMIT 1
  `);
  const schemaName = rows(result)[0]?.schema_name;
  return typeof schemaName === "string" && schemaName.length > 0 ? schemaName : null;
}

/** Install or refresh mutation, truncate, and agent-deletion guards. */
export async function applyIdentityClaimJournalGuard(db: DrizzleDatabase): Promise<boolean> {
  const schemaName = await findAuthoritySchema(db);
  if (!schemaName) return false;

  const schema = sql.identifier(schemaName);
  const journal = sql`${schema}.${sql.identifier("identity_claim_journal")}`;
  const retention = sql`${schema}.${sql.identifier("identity_claim_retention_ledger")}`;
  const agents = sql`${schema}.${sql.identifier("agents")}`;
  const rejectMutation = sql`${schema}.${sql.identifier("reject_identity_claim_history_mutation")}`;
  const rejectTruncate = sql`${schema}.${sql.identifier("reject_identity_claim_history_truncate")}`;
  const retainDeletion = sql`${schema}.${sql.identifier("retain_identity_claim_deletion_receipt")}`;

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${rejectMutation}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_TABLE_NAME = 'identity_claim_journal'
         AND TG_OP = 'DELETE'
         AND NOT EXISTS (SELECT 1 FROM ${agents} WHERE id = OLD.agent_id) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
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
      RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END;
    $$
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${retainDeletion}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM ${journal} WHERE agent_id = OLD.id) THEN
        INSERT INTO ${retention} DEFAULT VALUES;
      END IF;
      RETURN OLD;
    END;
    $$
  `);

  await db.execute(sql`DROP TRIGGER IF EXISTS identity_claim_journal_append_only ON ${journal}`);
  await db.execute(sql`
    CREATE TRIGGER identity_claim_journal_append_only
    BEFORE UPDATE OR DELETE ON ${journal}
    FOR EACH ROW EXECUTE FUNCTION ${rejectMutation}()
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_claim_retention_ledger_append_only ON ${retention}`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_claim_retention_ledger_append_only
    BEFORE UPDATE OR DELETE ON ${retention}
    FOR EACH ROW EXECUTE FUNCTION ${rejectMutation}()
  `);
  await db.execute(
    sql`DROP TRIGGER IF EXISTS identity_claim_journal_retention_on_agent_delete ON ${agents}`
  );
  await db.execute(sql`
    CREATE TRIGGER identity_claim_journal_retention_on_agent_delete
    BEFORE DELETE ON ${agents}
    FOR EACH ROW EXECUTE FUNCTION ${retainDeletion}()
  `);

  for (const [table, triggerName] of [
    [journal, "identity_claim_journal_no_truncate"],
    [retention, "identity_claim_retention_no_truncate"],
    [agents, "identity_claim_agents_no_truncate"],
  ] as const) {
    await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(triggerName)} ON ${table}`);
    await db.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION ${rejectTruncate}()
    `);
  }
  return true;
}
