-- Idempotent repair for production databases that advanced past 0107 without
-- the warm-pool columns present on agent_sandboxes.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "pool_status" text,
  ADD COLUMN IF NOT EXISTS "pool_ready_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz;

CREATE INDEX IF NOT EXISTS "agent_sandboxes_pool_unclaimed_idx"
  ON "agent_sandboxes" ("pool_ready_at" ASC NULLS LAST)
  WHERE "pool_status" = 'unclaimed';

INSERT INTO "organizations" ("id", "name", "slug", "credit_balance", "is_active")
VALUES (
  '00000000-0000-4000-8000-000000077001',
  'Warm Pool (system)',
  '__warm_pool__',
  0,
  false
)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  has_steward_user_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'steward_user_id'
  ) INTO has_steward_user_id;

  IF has_steward_user_id THEN
    EXECUTE 'INSERT INTO "users" ("id", "name", "organization_id", "role", "wallet_verified", "is_active", "steward_user_id")
             VALUES (''00000000-0000-4000-8000-000000077002'', ''Warm Pool (system)'', ''00000000-0000-4000-8000-000000077001'', ''system'', false, false, ''system:warm-pool'')
             ON CONFLICT DO NOTHING';
  ELSE
    EXECUTE 'INSERT INTO "users" ("id", "name", "organization_id", "role", "wallet_verified", "is_active")
             VALUES (''00000000-0000-4000-8000-000000077002'', ''Warm Pool (system)'', ''00000000-0000-4000-8000-000000077001'', ''system'', false, false)
             ON CONFLICT DO NOTHING';
  END IF;
END $$;
