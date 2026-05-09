-- Container warm-pool tracking on agent_sandboxes.
--
-- Pool entries are agent_sandboxes rows owned by the sentinel "Warm Pool" org
-- whose docker container is already running but unassigned to a user. On
-- claim, the user's pending sandbox row inherits the pool row's compute (one
-- transaction, FOR UPDATE SKIP LOCKED), and the pool row is deleted.
--
-- pool_status:
--   NULL        normal user sandbox
--   'unclaimed' a warm pool entry awaiting claim
--
-- pool_ready_at: when the pool container passed health checks and became claimable.
-- claimed_at:    set on the user's row at claim time (audit only).

INSERT INTO "organizations" ("id", "name", "slug", "credit_balance", "is_active")
VALUES (
  '00000000-0000-4000-8000-000000077001',
  'Warm Pool (system)',
  '__warm_pool__',
  0,
  false
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "users" ("id", "name", "organization_id", "role", "wallet_verified", "is_active", "steward_user_id")
VALUES (
  '00000000-0000-4000-8000-000000077002',
  'Warm Pool (system)',
  '00000000-0000-4000-8000-000000077001',
  'system',
  false,
  false,
  'system:warm-pool'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "pool_status" text,
  ADD COLUMN IF NOT EXISTS "pool_ready_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz;

CREATE INDEX IF NOT EXISTS "agent_sandboxes_pool_unclaimed_idx"
  ON "agent_sandboxes" ("pool_ready_at" ASC NULLS LAST)
  WHERE "pool_status" = 'unclaimed';
