-- Migration: Phase 3 — finalize Steward identity, retire Privy identity columns
--
-- PRECONDITIONS (operator MUST verify before running):
--   1. Phase 1 (`0001_add_steward_user_id_columns.sql`) verification passed.
--   2. Application backfill in `packages/lib/steward-sync.ts` has been
--      running long enough that every active user has been re-authenticated
--      and linked. Concretely, this query should return zero rows for
--      active human accounts:
--
--        SELECT id, email, wallet_address, privy_user_id
--        FROM users
--        WHERE privy_user_id IS NOT NULL
--          AND steward_user_id IS NULL
--          AND is_active = TRUE
--          AND is_anonymous = FALSE
--          -- exclude email-only affiliate placeholder rows
--          AND email NOT LIKE 'affiliate-%@anonymous.elizacloud.ai';
--
--      If this returns >0 rows, STOP. Either keep waiting for users to
--      re-auth, or run an operator-side reconciliation script that links
--      remaining accounts by email/wallet match before proceeding.
--
--   3. A full DB snapshot has been taken in the environment being migrated.
--   4. The `privy_user_id` columns are no longer read by application code.
--
-- WHAT THIS DOES (in order, single transaction):
--   A. Asserts the unlinked-row count is zero (defense-in-depth).
--   B. Adds NOT NULL to users.steward_user_id and
--      user_identities.steward_user_id.
--   C. Drops the privy_user_id columns from both tables.
--      The unique constraints + btree indexes on those columns are dropped
--      automatically by PostgreSQL when the column drops (CASCADE not
--      needed for column-attached indexes).
--   D. Drops the now-orphan repository helpers' index references via
--      explicit DROP INDEX IF EXISTS for any indexes that survived
--      separately (defensive — the column-drop should already cover this).
--
-- LOCKING NOTES:
--   - `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` requires an ACCESS
--     EXCLUSIVE lock and DOES scan the table to validate. On Postgres 12+,
--     a NOT NULL CHECK constraint added with NOT VALID then VALIDATEd
--     under SHARE UPDATE EXCLUSIVE lets Postgres skip the redundant scan
--     when SET NOT NULL is then issued. We use that pattern for both
--     `users` and `user_identities` for consistency — the VALIDATE step
--     on `user_identities` is cheap regardless, and using one pattern
--     keeps the migration easier to reason about.
--   - `VALIDATE CONSTRAINT` takes SHARE UPDATE EXCLUSIVE — concurrent
--     SELECT/INSERT/UPDATE/DELETE remain unblocked, only other DDL is
--     blocked. The subsequent `SET NOT NULL` takes ACCESS EXCLUSIVE
--     briefly but skips the table scan because the CHECK constraint
--     already proved no-NULLs.
--   - `ALTER TABLE ... DROP COLUMN` is fast (metadata-only) and takes
--     ACCESS EXCLUSIVE briefly.
--   - This migration is intended to run during a planned maintenance
--     window, not online.
--
-- IF SOMETHING GOES WRONG MID-MIGRATION:
--   The whole migration runs in a single transaction. ROLLBACK restores
--   the schema. Note however that COMMIT cannot be undone — once committed,
--   the privy_user_id columns are gone. Restore from snapshot is the only
--   recovery for an after-COMMIT regret.

BEGIN;

-- CI and older environments may have the warm-pool sentinel user from
-- 0107 before that migration started writing steward_user_id. Repair that
-- system-only row before enforcing NOT NULL.
UPDATE "users"
  SET "steward_user_id" = 'system:warm-pool'
  WHERE "id" = '00000000-0000-4000-8000-000000077002'
    AND "steward_user_id" IS NULL;

-- A. Defensive precondition check inside the transaction itself.
DO $$
DECLARE
  unlinked_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO unlinked_count
    FROM "users"
    WHERE "privy_user_id" IS NOT NULL
      AND "steward_user_id" IS NULL
      AND "is_active" = TRUE
      AND "is_anonymous" = FALSE
      AND ("email" IS NULL OR "email" NOT LIKE 'affiliate-%@anonymous.elizacloud.ai');

  IF unlinked_count > 0 THEN
    RAISE EXCEPTION
      'Phase 3 aborted: % active human users still have privy_user_id but no steward_user_id. Backfill incomplete.',
      unlinked_count;
  END IF;
END $$;

-- B. Promote steward_user_id to NOT NULL.
--
-- B.1 users — use NOT VALID + VALIDATE to avoid a table-blocking scan
--     under ACCESS EXCLUSIVE. We then promote the column to NOT NULL,
--     which Postgres 12+ recognizes as already validated by the
--     constraint and skips the redundant scan.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_steward_user_id_not_null_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_steward_user_id_not_null_check"
      CHECK ("steward_user_id" IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE "users"
  VALIDATE CONSTRAINT "users_steward_user_id_not_null_check";

ALTER TABLE "users"
  ALTER COLUMN "steward_user_id" SET NOT NULL;

-- The CHECK constraint is now redundant with the column-level NOT NULL.
-- Drop it to keep the schema clean.
ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_steward_user_id_not_null_check";

-- B.2 user_identities — same pattern (kept consistent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_identities_steward_user_id_not_null_check'
      AND conrelid = 'public.user_identities'::regclass
  ) THEN
    ALTER TABLE "user_identities"
      ADD CONSTRAINT "user_identities_steward_user_id_not_null_check"
      CHECK ("steward_user_id" IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE "user_identities"
  VALIDATE CONSTRAINT "user_identities_steward_user_id_not_null_check";

ALTER TABLE "user_identities"
  ALTER COLUMN "steward_user_id" SET NOT NULL;

ALTER TABLE "user_identities"
  DROP CONSTRAINT IF EXISTS "user_identities_steward_user_id_not_null_check";

-- C. Drop the legacy Privy identity columns.
--    DROP COLUMN automatically drops the column's UNIQUE constraint and
--    any indexes that reference only that column.

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "privy_user_id";

ALTER TABLE "user_identities"
  DROP COLUMN IF EXISTS "privy_user_id";

-- D. Defensive: drop the named indexes / constraints in case any survived.
--    Under normal Postgres semantics these are already gone after step C,
--    but IF EXISTS makes this safe and idempotent.

DROP INDEX IF EXISTS "users_privy_idx";
DROP INDEX IF EXISTS "user_identities_privy_user_id_idx";

-- The unique constraints `users_privy_user_id_unique` and
-- `user_identities_privy_user_id_unique` are column-attached and are
-- removed by the DROP COLUMN above. No explicit DROP CONSTRAINT needed.

COMMIT;
