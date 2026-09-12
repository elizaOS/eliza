-- PR3: exact-request approval binding and safe resume (authority plan PR3).
--
-- This migration turns the PR2 `approval_required` provider action into a
-- recent-human, exact-request approval and a safe `steward-system` resume. It:
--
--   1. Adds `secret_routes.authority_revision` + a BEFORE UPDATE bump trigger
--      (G1 orchestrator adjudication: PR3's approval commitment binds a route
--      revision, so the column must exist in PR3's migration, not PR4's 0082).
--   2. Turns `approval_queue` into a discriminated union of the legacy
--      transaction approval and the new provider-intent approval (spec §4.1).
--      NO `provider_action_approvals` table is created (spec §1).
--   3. Extends `provider_action_bindings` with the approval lifecycle columns
--      and REPLACES the PR2 immutability trigger with the PR3 transition trigger
--      (spec §4.2).
--
-- `intents` remains the sole lifecycle root (adjudication conflict 16). There is
-- no second approval, decision, or execution ledger.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. secret_routes.authority_revision + bump trigger (G1)
-- ─────────────────────────────────────────────────────────────────────────────
-- The bump trigger mirrors PR1's 0079 trigger pattern. It stales an unconsumed
-- v2 authorization on route rotation (PR4 X5), and — more relevantly for PR3 —
-- it makes the route revision PR3 binds move whenever the route is mutated, so
-- resume can detect a rotated route (N40 APPROVAL_ROUTE_STALE). PR4's 0082 adds
-- `authority_mode`, `provider_operation_id`, and the governed-mode CHECK; those
-- are intentionally NOT here.
ALTER TABLE "secret_routes"
  ADD COLUMN "authority_revision" integer NOT NULL DEFAULT 1 CHECK ("authority_revision" > 0);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION steward_bump_secret_route_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Increment authority_revision by exactly 1 whenever any bound route field
  -- changes. Mirror PR4 §1.2: host_pattern, path_pattern, method, inject_as,
  -- inject_key, inject_format, secret_id, enabled changing all bump the
  -- revision. (authority_mode / provider_operation_id land in PR4's 0082; when
  -- that migration adds them it will extend this function's predicate.)
  IF (
    OLD."host_pattern"  IS DISTINCT FROM NEW."host_pattern"  OR
    OLD."path_pattern"  IS DISTINCT FROM NEW."path_pattern"  OR
    OLD."method"        IS DISTINCT FROM NEW."method"        OR
    OLD."inject_as"     IS DISTINCT FROM NEW."inject_as"     OR
    OLD."inject_key"    IS DISTINCT FROM NEW."inject_key"    OR
    OLD."inject_format" IS DISTINCT FROM NEW."inject_format" OR
    OLD."secret_id"     IS DISTINCT FROM NEW."secret_id"     OR
    OLD."enabled"       IS DISTINCT FROM NEW."enabled"
  ) THEN
    NEW."authority_revision" := OLD."authority_revision" + 1;
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER secret_routes_bump_authority_revision
  BEFORE UPDATE ON "secret_routes"
  FOR EACH ROW EXECUTE FUNCTION steward_bump_secret_route_authority_revision();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. approval_queue: discriminated union (transaction | provider_action)
-- ─────────────────────────────────────────────────────────────────────────────
-- Legacy transaction approvals keep tx_id NOT NULL semantics via the arm CHECK.
ALTER TABLE "approval_queue" ALTER COLUMN "tx_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "intent_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "approval_kind" varchar(32) NOT NULL DEFAULT 'transaction';
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "tenant_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "request_hash" varchar(71);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "action_digest" varchar(71);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "approval_commitment" jsonb;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "approval_commitment_hash" varchar(71);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "expected_binding_revision" integer;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "expires_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "decision" varchar(16);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "reason_code" varchar(96);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "reason" text;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "mfa_verified_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "mfa_age_ms_at_decision" integer;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "decision_idempotency_key_hash" varchar(71);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "decision_request_hash" varchar(71);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "consumed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "consumed_by" varchar(64);
--> statement-breakpoint

-- New provider lifecycle statuses. The enum already carries pending/approved/
-- rejected (transaction arm reuses those).
ALTER TYPE "approval_queue_status" ADD VALUE IF NOT EXISTS 'expired';
--> statement-breakpoint
ALTER TYPE "approval_queue_status" ADD VALUE IF NOT EXISTS 'stale';
--> statement-breakpoint
ALTER TYPE "approval_queue_status" ADD VALUE IF NOT EXISTS 'consumed';
--> statement-breakpoint

-- Backfill legacy rows explicitly (the DEFAULT already set 'transaction', this
-- is belt-and-suspenders for any row inserted before the DEFAULT existed).
UPDATE "approval_queue" SET "approval_kind" = 'transaction' WHERE "approval_kind" IS NULL;
--> statement-breakpoint

-- Composite FK: a provider row's (tenant_id, intent_id) must reference a real
-- intent. Legacy rows carry NULL tenant_id/intent_id and are exempt (the FK is
-- NULL-permissive on either column).
ALTER TABLE "approval_queue"
  ADD CONSTRAINT "approval_queue_intent_fk"
  FOREIGN KEY ("tenant_id", "intent_id")
  REFERENCES "intents" ("tenant_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

-- Arm discriminator: transaction rows keep tx_id and carry no provider fields;
-- provider rows carry the full exact-binding tuple and no tx_id.
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_arm_chk" CHECK (
  ("approval_kind" = 'transaction'
    AND "tx_id" IS NOT NULL AND "intent_id" IS NULL
    AND "workspace_id" IS NULL AND "request_hash" IS NULL
    AND "action_digest" IS NULL AND "approval_commitment" IS NULL
    AND "approval_commitment_hash" IS NULL)
  OR
  ("approval_kind" = 'provider_action'
    AND "tx_id" IS NULL AND "intent_id" IS NOT NULL
    AND "tenant_id" IS NOT NULL AND "workspace_id" IS NOT NULL
    AND "request_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "action_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "approval_commitment" IS NOT NULL
    AND "approval_commitment_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "expected_binding_revision" > 0
    AND "expires_at" IS NOT NULL)
);
--> statement-breakpoint

-- Decision shape: pin the (status, decision, resolution, mfa, consumption)
-- tuple for every provider lifecycle state. Legacy transaction rows are exempt.
--
-- NOTE: `status` is compared via `::text` because this CHECK references the
-- enum values ('expired','stale','consumed') that are ADDed to
-- approval_queue_status EARLIER in THIS migration. Postgres forbids using a
-- newly-added enum value in the same transaction it was added ("unsafe use of
-- new value"), and drizzle-orm's migrator wraps a migration file in one
-- transaction. Casting the enum column to text sidesteps the enum-literal bind
-- at constraint-creation time and is semantically identical.
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_decision_shape_chk" CHECK (
  ("approval_kind" = 'transaction') OR
  ("status"::text = 'pending' AND "decision" IS NULL AND "resolved_at" IS NULL
    AND "resolved_by_type" IS NULL AND "resolved_by_id" IS NULL
    AND "mfa_verified_at" IS NULL AND "consumed_at" IS NULL)
  OR
  ("status"::text = 'approved' AND "decision" = 'approve' AND "resolved_at" IS NOT NULL
    AND "resolved_by_type" = 'user' AND "resolved_by_id" IS NOT NULL
    AND "mfa_verified_at" IS NOT NULL AND "consumed_at" IS NULL)
  OR
  ("status"::text = 'rejected' AND "decision" = 'deny' AND "resolved_at" IS NOT NULL
    AND "resolved_by_type" = 'user' AND "resolved_by_id" IS NOT NULL
    AND "mfa_verified_at" IS NOT NULL AND "consumed_at" IS NULL)
  OR
  ("status"::text IN ('expired','stale') AND "decision" IS NULL AND "consumed_at" IS NULL)
  OR
  ("status"::text = 'consumed' AND "decision" = 'approve' AND "resolved_at" IS NOT NULL
    AND "resolved_by_type" = 'user' AND "resolved_by_id" IS NOT NULL
    AND "mfa_verified_at" IS NOT NULL AND "consumed_at" IS NOT NULL
    AND "consumed_by" = 'steward-system')
);
--> statement-breakpoint

-- One approval row per intent (partial unique on the provider arm).
CREATE UNIQUE INDEX "approval_queue_intent_id_idx"
  ON "approval_queue" ("intent_id") WHERE "intent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "approval_queue_provider_scope_status_idx"
  ON "approval_queue" ("tenant_id", "workspace_id", "status", "requested_at" DESC)
  WHERE "approval_kind" = 'provider_action';
--> statement-breakpoint
-- Decision idempotency is scoped to (tenant, approver, key-hash) on the
-- provider arm; the key is only ever stored hashed.
CREATE UNIQUE INDEX "approval_queue_provider_decision_idem_idx"
  ON "approval_queue" ("tenant_id", "resolved_by_id", "decision_idempotency_key_hash")
  WHERE "approval_kind" = 'provider_action'
    AND "decision_idempotency_key_hash" IS NOT NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. provider_action_bindings: approval lifecycle columns + PR3 transition trigger
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "provider_action_bindings"
  ADD COLUMN "binding_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "approval_queue_id" varchar(64),
  ADD COLUMN "approval_actor_user_id" uuid,
  ADD COLUMN "approval_commitment_hash" varchar(71),
  ADD COLUMN "approved_at" timestamptz,
  ADD COLUMN "denied_at" timestamptz,
  ADD COLUMN "expired_at" timestamptz,
  ADD COLUMN "stale_at" timestamptz,
  ADD COLUMN "stale_reason_code" varchar(96),
  ADD COLUMN "resume_actor" varchar(64),
  ADD COLUMN "resume_attempt_id" uuid,
  ADD COLUMN "resume_validated_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "provider_action_bindings"
  ADD CONSTRAINT "provider_action_bindings_binding_revision_chk"
    CHECK ("binding_revision" > 0);
--> statement-breakpoint

-- One binding per approval-queue row (partial unique; NULL until a queue exists).
CREATE UNIQUE INDEX "provider_action_bindings_approval_queue_id_uniq"
  ON "provider_action_bindings" ("approval_queue_id")
  WHERE "approval_queue_id" IS NOT NULL;
--> statement-breakpoint

-- Extend the status allowlist to the PR3 approval lifecycle. Drop the PR2 CHECK
-- and re-add it with the full set. PR4 later adds executing/succeeded/failed/
-- outcome_unknown.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_status_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_status_chk"
  CHECK ("status" IN (
    'denied','pending_approval','allowed_stub','stub_succeeded','stub_failed',
    'approved','execution_ready','approval_denied','approval_expired','approval_stale'
  ));
--> statement-breakpoint

-- The PR2 `_state_chk` pins (access_effect, policy_effect, status). Approval
-- lifecycle transitions move `status` away from 'pending_approval' while the
-- decision effects stay fixed, so the old equality must be relaxed to allow all
-- of the approval-required lineage statuses.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_state_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_state_chk" CHECK (
  ("access_effect" = 'deny' AND "policy_effect" = 'not_evaluated' AND "status" = 'denied') OR
  ("access_effect" = 'allow' AND "policy_effect" = 'hard_deny' AND "status" = 'denied') OR
  ("access_effect" = 'allow' AND "policy_effect" = 'approval_required'
    AND "status" IN ('pending_approval','approved','execution_ready',
                     'approval_denied','approval_expired','approval_stale')) OR
  ("access_effect" = 'allow' AND "policy_effect" = 'allow'
    AND "status" IN ('allowed_stub','stub_succeeded','stub_failed'))
);
--> statement-breakpoint

-- Drop the PR2 immutability trigger BEFORE the legacy backfill so the backfill
-- UPDATE (pending_approval -> approval_stale on pre-existing rows) is not
-- rejected by the PR2 transition allowlist / frozen-column guard. The PR3
-- transition trigger is (re)created at the end of this migration.
DROP TRIGGER IF EXISTS provider_action_bindings_immutable ON "provider_action_bindings";
--> statement-breakpoint
DROP FUNCTION IF EXISTS steward_provider_action_binding_guard();
--> statement-breakpoint

-- Backfill legacy PR2 `pending_approval` rows BEFORE adding the shape CHECK. On
-- a database that already carries approval-required actions created under PR2
-- (before this migration), the new approval columns are NULL, and the pending
-- branch of the shape CHECK requires approval_queue_id + approval_commitment_hash
-- to be NOT NULL. Rather than fabricate an unverifiable commitment for a legacy
-- row, transition any pre-existing pending_approval binding (and its intent) to
-- the terminal `approval_stale` classification with a stable migration reason so
-- the requester must re-request under the exact-binding regime. This keeps the
-- migration forward-safe on deployments with outstanding approvals.
UPDATE "provider_action_bindings"
  SET "status" = 'approval_stale',
      "stale_at" = now(),
      "stale_reason_code" = 'APPROVAL_MIGRATED_PR3',
      -- approval_queue_id is required by the stale branch of the shape CHECK; a
      -- legacy pending row has none, so synthesize a stable placeholder id that
      -- references no queue row (the stale branch only requires NOT NULL).
      "approval_queue_id" = 'aq_migrated_' || "intent_id",
      "updated_at" = now()
  WHERE "status" = 'pending_approval';
--> statement-breakpoint
UPDATE "intents" i
  SET "status" = 'canceled',
      "canceled_by" = 'steward-system',
      "canceled_at" = now(),
      "cancellation_reason" = 'APPROVAL_MIGRATED_PR3',
      "updated_at" = now()
  FROM "provider_action_bindings" b
  WHERE b."intent_id" = i."id"
    AND b."stale_reason_code" = 'APPROVAL_MIGRATED_PR3'
    AND i."status" = 'pending';
--> statement-breakpoint

-- Per-state field-shape CHECK (spec §4.2): which lifecycle columns must be set
-- for each approval status. Non-approval statuses (PR2 lineage) carry none.
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_approval_shape_chk" CHECK (
  ("status" NOT IN ('pending_approval','approved','execution_ready','approval_denied','approval_expired','approval_stale')
    AND "approval_actor_user_id" IS NULL AND "approved_at" IS NULL AND "denied_at" IS NULL
    AND "expired_at" IS NULL AND "stale_at" IS NULL
    AND "resume_actor" IS NULL AND "resume_attempt_id" IS NULL AND "resume_validated_at" IS NULL)
  OR
  ("status" = 'pending_approval'
    AND "approval_queue_id" IS NOT NULL AND "approval_commitment_hash" IS NOT NULL
    AND "approval_actor_user_id" IS NULL AND "approved_at" IS NULL AND "denied_at" IS NULL
    AND "expired_at" IS NULL AND "stale_at" IS NULL
    AND "resume_actor" IS NULL AND "resume_attempt_id" IS NULL AND "resume_validated_at" IS NULL)
  OR
  ("status" = 'approved'
    AND "approval_queue_id" IS NOT NULL AND "approval_commitment_hash" IS NOT NULL
    AND "approval_actor_user_id" IS NOT NULL AND "approved_at" IS NOT NULL
    AND "denied_at" IS NULL AND "expired_at" IS NULL AND "stale_at" IS NULL
    AND "resume_actor" IS NULL AND "resume_attempt_id" IS NULL AND "resume_validated_at" IS NULL)
  OR
  ("status" = 'execution_ready'
    AND "approval_queue_id" IS NOT NULL AND "approval_commitment_hash" IS NOT NULL
    AND "approval_actor_user_id" IS NOT NULL AND "approved_at" IS NOT NULL
    AND "resume_actor" = 'steward-system' AND "resume_attempt_id" IS NOT NULL
    AND "resume_validated_at" IS NOT NULL)
  OR
  ("status" = 'approval_denied'
    AND "approval_queue_id" IS NOT NULL AND "approval_actor_user_id" IS NOT NULL
    AND "denied_at" IS NOT NULL
    AND "approved_at" IS NULL AND "expired_at" IS NULL AND "stale_at" IS NULL
    AND "resume_actor" IS NULL)
  OR
  ("status" = 'approval_expired'
    AND "approval_queue_id" IS NOT NULL AND "expired_at" IS NOT NULL
    AND "denied_at" IS NULL AND "stale_at" IS NULL AND "resume_actor" IS NULL)
  OR
  ("status" = 'approval_stale'
    AND "approval_queue_id" IS NOT NULL AND "stale_at" IS NOT NULL
    AND "stale_reason_code" IS NOT NULL
    AND "denied_at" IS NULL AND "expired_at" IS NULL AND "resume_actor" IS NULL)
);
--> statement-breakpoint

-- Replace the PR2 immutability trigger with the PR3 transition trigger. PR3
-- freezes the immutable PR2 columns, permits only the lifecycle columns to
-- change, enforces the legal transition graph, and requires binding_revision to
-- increment by exactly one on every state-changing transition (spec §4.2).
DROP TRIGGER IF EXISTS provider_action_bindings_immutable ON "provider_action_bindings";
--> statement-breakpoint
DROP FUNCTION IF EXISTS steward_provider_action_binding_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION steward_provider_action_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  frozen_old jsonb;
  frozen_new jsonb;
  mutable text[] := ARRAY[
    'status','binding_revision','approval_actor_user_id','approval_queue_id',
    'approval_commitment_hash','approved_at','denied_at','expired_at','stale_at',
    'stale_reason_code','resume_actor','resume_attempt_id','resume_validated_at','updated_at'
  ];
  col text;
BEGIN
  -- Freeze every PR2 immutable column. Strip the mutable lifecycle columns from
  -- both projections; any residual difference is a frozen-column mutation.
  frozen_old := to_jsonb(OLD);
  frozen_new := to_jsonb(NEW);
  FOREACH col IN ARRAY mutable LOOP
    frozen_old := frozen_old - col;
    frozen_new := frozen_new - col;
  END LOOP;
  IF frozen_old IS DISTINCT FROM frozen_new THEN
    RAISE EXCEPTION 'provider_action_bindings frozen column mutated' USING ERRCODE = '23514';
  END IF;

  -- Transition allowlist.
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF (OLD.status = 'allowed_stub' AND NEW.status IN ('stub_succeeded','stub_failed')) THEN
      -- PR2 stub lineage: does NOT participate in the binding_revision optimistic
      -- lock (PR2 sets only status/updated_at). Leave binding_revision unchanged.
      IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision THEN
        RAISE EXCEPTION 'provider_action_bindings stub transition must not change binding_revision'
          USING ERRCODE = '23514';
      END IF;
    ELSIF (
      -- PR3 approval lifecycle.
      (OLD.status = 'pending_approval' AND NEW.status IN ('approved','approval_denied','approval_expired','approval_stale')) OR
      (OLD.status = 'approved'         AND NEW.status IN ('execution_ready','approval_expired','approval_stale'))
    ) THEN
      -- Every PR3 lifecycle transition increments binding_revision by exactly 1.
      IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision + 1 THEN
        RAISE EXCEPTION 'provider_action_bindings binding_revision must increment by exactly one on transition'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'illegal provider_action_bindings status transition'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    -- No status change: binding_revision must not move (the only writer of the
    -- lifecycle is the transition path; a no-op update cannot bump it).
    IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision THEN
      RAISE EXCEPTION 'provider_action_bindings binding_revision changed without a status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER provider_action_bindings_immutable
  BEFORE UPDATE ON "provider_action_bindings"
  FOR EACH ROW EXECUTE FUNCTION steward_provider_action_binding_guard();
