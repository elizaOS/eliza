-- Migration: Phase 1 — verify steward_user_id columns exist
--
-- BACKGROUND
--   Per AUTH_MIGRATION_NOTES.md, the Privy → Steward identity-link plan is
--   a 3-phase migration. The original plan called for Phase 1 to be the
--   additive ADD COLUMN step.
--
--   That step is ALREADY APPLIED in production by the in-tree migration
--   `0061_add_steward_user_identity_columns.sql`. Both `users.steward_user_id`
--   and `user_identities.steward_user_id` exist as nullable TEXT columns
--   with unique + btree indexes.
--
-- WHAT THIS DRAFT DOES
--   This file is intentionally a verification-only no-op. It re-asserts the
--   columns + indexes the operator should expect to see before running
--   Phase 3 (finalize). It uses information_schema and pg_indexes to fail
--   fast if any expected object is missing — which would mean migration
--   0061 was somehow skipped or partially applied.
--
--   The DO blocks raise NOTICE on success and EXCEPTION on failure. The
--   migration creates no objects.
--
-- IF THIS FAILS
--   Stop. Do not run Phase 3. Investigate why 0061 did not apply (likely
--   a partial deploy or a schema drift). Re-run 0061 against the affected
--   environment first.

BEGIN;

DO $$
BEGIN
  -- users.steward_user_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'steward_user_id'
      AND data_type = 'text'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'Phase 1 verification failed: users.steward_user_id missing or wrong shape. Re-run 0061_add_steward_user_identity_columns.sql.';
  END IF;

  -- user_identities.steward_user_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_identities'
      AND column_name = 'steward_user_id'
      AND data_type = 'text'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'Phase 1 verification failed: user_identities.steward_user_id missing or wrong shape. Re-run 0061_add_steward_user_identity_columns.sql.';
  END IF;

  -- users_steward_user_id_unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND indexname = 'users_steward_user_id_unique'
  ) THEN
    RAISE EXCEPTION
      'Phase 1 verification failed: users_steward_user_id_unique missing.';
  END IF;

  -- user_identities_steward_user_id_unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_identities'
      AND indexname = 'user_identities_steward_user_id_unique'
  ) THEN
    RAISE EXCEPTION
      'Phase 1 verification failed: user_identities_steward_user_id_unique missing.';
  END IF;

  -- users_steward_idx (btree lookup)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND indexname = 'users_steward_idx'
  ) THEN
    RAISE EXCEPTION
      'Phase 1 verification failed: users_steward_idx missing.';
  END IF;

  -- user_identities_steward_user_id_idx (btree lookup)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_identities'
      AND indexname = 'user_identities_steward_user_id_idx'
  ) THEN
    RAISE EXCEPTION
      'Phase 1 verification failed: user_identities_steward_user_id_idx missing.';
  END IF;

  RAISE NOTICE 'Phase 1 verification passed: steward_user_id columns + indexes present on users and user_identities.';
END $$;

COMMIT;
