/**
 * Repairs membership authority freshness checks that runtime schema diffing
 * cannot update when an existing constraint keeps the same name. A durable
 * constraint comment is the restart fast path; PostgreSQL upgrades serialize
 * with a transaction-scoped advisory lock before taking table locks.
 */
import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "./types";

const CONSTRAINT_VERSION = "elizaos:membership-authority-ttl:v1";

type DatabaseBackend = "postgres" | "pglite" | "unknown";

interface CountRow {
  [key: string]: unknown;
  count: number | string;
}

function rows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];
  const resultRows = (value as { rows?: unknown }).rows;
  return Array.isArray(resultRows) ? resultRows : [];
}

async function hasCurrentConstraints(db: DrizzleDatabase): Promise<boolean> {
  const result = await db.execute<CountRow>(sql`
    SELECT COUNT(*) AS count
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation
        ON relation.oid = constraint_record.conrelid
     WHERE relation.relnamespace = 'public'::regnamespace
       AND (
         (
           relation.relname = 'membership_authority_scopes'
           AND constraint_record.conname = 'membership_authority_scope_current_check'
         )
         OR (
           relation.relname = 'membership_authority'
           AND constraint_record.conname = 'membership_authority_version_check'
         )
       )
       AND obj_description(constraint_record.oid, 'pg_constraint') = ${CONSTRAINT_VERSION}
  `);
  return Number(result.rows[0]?.count ?? 0) === 2;
}

async function bothAuthorityTablesExist(db: DrizzleDatabase): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('membership_authority_scopes', 'membership_authority')
  `);
  return rows(result).length === 2;
}

/** Atomically enforce observation-relative 24-hour membership evidence windows. */
export async function applyMembershipAuthorityTtlConstraints(
  db: DrizzleDatabase,
  databaseBackend: DatabaseBackend
): Promise<boolean> {
  if (await hasCurrentConstraints(db)) return true;
  if (!(await bothAuthorityTablesExist(db))) return false;

  return db.transaction(async (tx) => {
    if (databaseBackend === "postgres") {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('elizaos.plugin-sql'),
          hashtext('membership-authority-ttl-v1')
        )
      `);
    }

    // A process may have completed the upgrade while this transaction waited
    // for the advisory lock. Rechecking avoids all authority-table work.
    if (await hasCurrentConstraints(tx)) return true;
    if (!(await bothAuthorityTablesExist(tx))) return false;

    if (databaseBackend === "postgres") {
      // Acquire the strongest locks in one fixed order before any UPDATE. This
      // prevents the RowExclusive -> AccessExclusive lock-upgrade deadlock
      // that concurrent startups could trigger in the original repair.
      await tx.execute(sql`
        LOCK TABLE membership_authority_scopes, membership_authority
          IN ACCESS EXCLUSIVE MODE
      `);
    }

    // Evidence that exceeded the newly bounded contract was never safe to keep
    // authoritative. Shorten only its expiry; preserve the retained fact.
    await tx.execute(sql`
      UPDATE membership_authority_scopes
         SET valid_until = observed_at + INTERVAL '24 hours'
       WHERE valid_until > observed_at + INTERVAL '24 hours'
    `);
    await tx.execute(sql`
      UPDATE membership_authority
         SET valid_until = observed_at + INTERVAL '24 hours'
       WHERE valid_until > observed_at + INTERVAL '24 hours'
    `);

    await tx.execute(sql`
      ALTER TABLE membership_authority_scopes
        DROP CONSTRAINT IF EXISTS membership_authority_scope_current_check
    `);
    await tx.execute(sql`
      ALTER TABLE membership_authority_scopes
        ADD CONSTRAINT membership_authority_scope_current_check
        CHECK (
          health <> 'current'
          OR (
            valid_until IS NOT NULL
            AND valid_until > observed_at
            AND valid_until <= observed_at + INTERVAL '24 hours'
            AND publisher_instance_id IS NOT NULL
            AND source_version >= 0
            AND source_cursor IS NOT NULL
          )
        )
    `);
    await tx.execute(sql`
      ALTER TABLE membership_authority
        DROP CONSTRAINT IF EXISTS membership_authority_version_check
    `);
    await tx.execute(sql`
      ALTER TABLE membership_authority
        ADD CONSTRAINT membership_authority_version_check
        CHECK (
          generation > 0
          AND source_version >= 0
          AND valid_until > observed_at
          AND valid_until <= observed_at + INTERVAL '24 hours'
        )
    `);

    await tx.execute(
      sql.raw(`
      COMMENT ON CONSTRAINT membership_authority_scope_current_check
        ON membership_authority_scopes IS '${CONSTRAINT_VERSION}'
    `)
    );
    await tx.execute(
      sql.raw(`
      COMMENT ON CONSTRAINT membership_authority_version_check
        ON membership_authority IS '${CONSTRAINT_VERSION}'
    `)
    );

    return true;
  });
}
