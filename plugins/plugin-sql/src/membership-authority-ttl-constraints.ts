/**
 * Repairs membership authority freshness checks that runtime schema diffing
 * cannot update when an existing constraint keeps the same name.
 */
import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "./types";

function rows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];
  const resultRows = (value as { rows?: unknown }).rows;
  return Array.isArray(resultRows) ? resultRows : [];
}

/** Atomically enforce observation-relative 24-hour membership evidence windows. */
export async function applyMembershipAuthorityTtlConstraints(
  db: DrizzleDatabase
): Promise<boolean> {
  const tables = await db.execute(sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('membership_authority_scopes', 'membership_authority')
  `);
  if (rows(tables).length !== 2) return false;

  await db.transaction(async (tx) => {
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
  });

  return true;
}
