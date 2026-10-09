-- PR4: execution authorization v2 + governed proxy cutover (authority plan PR4).
--
-- This migration makes the approved, immutable, `execution_ready` provider
-- action from PR3 the ONLY way a governed route can decrypt/inject a provider
-- credential and dispatch. It:
--
--   1. Extends `execution_authorization_nonces` with the v2 provider binding
--      (version discriminator + full commitment tuple + dispatch state machine).
--      NO second ledger: v1 (wallet/EVM) rows keep version=1 and null v2 fields.
--   2. Adds `secret_routes.authority_mode` (enum) + `provider_operation_id` +
--      the governed-mode CHECK, and EXTENDS the 0081 bump trigger predicate to
--      also bump `authority_revision` when authority_mode / provider_operation_id
--      change. (authority_revision + the trigger itself already landed in 0081
--      per the G1 orchestrator adjudication; do NOT re-add them here.)
--
-- `intents` remains the sole lifecycle root. The v2 nonce row is a subordinate,
-- per-execution claim artifact keyed 1:1 to the intent (exec_auth_nonces_intent_uniq).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. execution_authorization_nonces: v2 provider-execution extension
-- ─────────────────────────────────────────────────────────────────────────────
-- v1 columns (0078): id, authorization_id, request_id, tenant_id, agent_id,
-- capability, backend, payload_digest, policy_revision_hash, approval_id, nonce,
-- signature, idempotency_key, status, issued_at, expires_at, consumed_at,
-- created_at. All v2 columns are nullable/defaulted so existing v1 rows are
-- unaffected (version defaults to 1).
ALTER TABLE "execution_authorization_nonces"
  ADD COLUMN "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN "execution_id" varchar(64),
  ADD COLUMN "intent_id" varchar(64),
  ADD COLUMN "workspace_id" uuid,
  ADD COLUMN "provider_account_id" uuid,
  ADD COLUMN "operation_id" uuid,
  ADD COLUMN "operation_revision" integer,
  ADD COLUMN "request_hash" varchar(71),
  ADD COLUMN "action_digest" varchar(71),
  ADD COLUMN "grant_dependency_hash" varchar(71),
  ADD COLUMN "route_id" uuid,
  ADD COLUMN "route_revision" integer,
  ADD COLUMN "secret_id" uuid,
  ADD COLUMN "secret_version" integer,
  ADD COLUMN "provider_idempotency_key" varchar(255),
  ADD COLUMN "commitment_hash" varchar(71),
  ADD COLUMN "key_id" varchar(64),
  ADD COLUMN "dispatch_state" varchar(24) NOT NULL DEFAULT 'none',
  ADD COLUMN "dispatched_at" timestamptz,
  ADD COLUMN "outcome_recorded_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "execution_authorization_nonces"
  ADD CONSTRAINT "exec_auth_nonces_version_chk" CHECK ("version" IN (1, 2));
--> statement-breakpoint

-- v2 arm discriminator: legacy rows (version=1) keep null v2 fields; v2 rows
-- (version=2) require the full provider binding. capability/backend are reused:
-- v2 rows set backend='credential-proxy' and capability='credential.inject_http'.
ALTER TABLE "execution_authorization_nonces"
  ADD CONSTRAINT "exec_auth_nonces_v2_arm_chk" CHECK (
    ("version" = 1)
    OR
    ("version" = 2
      AND "execution_id" IS NOT NULL
      AND "intent_id" IS NOT NULL
      AND "workspace_id" IS NOT NULL
      AND "provider_account_id" IS NOT NULL
      AND "operation_id" IS NOT NULL
      AND "operation_revision" > 0
      AND "request_hash" ~ '^sha256:[0-9a-f]{64}$'
      AND "action_digest" ~ '^sha256:[0-9a-f]{64}$'
      AND "grant_dependency_hash" ~ '^sha256:[0-9a-f]{64}$'
      AND "route_id" IS NOT NULL
      AND "route_revision" > 0
      AND "secret_id" IS NOT NULL
      AND "secret_version" > 0
      AND "provider_idempotency_key" IS NOT NULL
      AND "commitment_hash" ~ '^sha256:[0-9a-f]{64}$'
      AND "key_id" IS NOT NULL
      AND "backend" = 'credential-proxy'
      AND "capability" = 'credential.inject_http')
  );
--> statement-breakpoint

ALTER TABLE "execution_authorization_nonces"
  ADD CONSTRAINT "exec_auth_nonces_dispatch_state_chk"
    CHECK ("dispatch_state" IN ('none','claimed','dispatched','succeeded','failed','outcome_unknown'));
--> statement-breakpoint

-- Terminal-state field shape: dispatched/succeeded/failed/outcome_unknown require
-- dispatched_at; none/claimed must not have it.
ALTER TABLE "execution_authorization_nonces"
  ADD CONSTRAINT "exec_auth_nonces_dispatch_shape_chk" CHECK (
    ("dispatch_state" = 'none' AND "dispatched_at" IS NULL)
    OR ("dispatch_state" = 'claimed' AND "dispatched_at" IS NULL)
    OR ("dispatch_state" IN ('dispatched','succeeded','failed','outcome_unknown') AND "dispatched_at" IS NOT NULL)
  );
--> statement-breakpoint

-- One v2 authorization per intent (a resumed intent mints exactly one).
CREATE UNIQUE INDEX "exec_auth_nonces_intent_uniq"
  ON "execution_authorization_nonces" ("intent_id") WHERE "version" = 2;
--> statement-breakpoint
-- One v2 authorization per execution_id.
CREATE UNIQUE INDEX "exec_auth_nonces_execution_uniq"
  ON "execution_authorization_nonces" ("execution_id") WHERE "version" = 2;
--> statement-breakpoint
-- Provider idempotency: scope to tenant+account+operation+key so a retried
-- reconciliation reuses one provider-side key.
CREATE UNIQUE INDEX "exec_auth_nonces_provider_idem_uniq"
  ON "execution_authorization_nonces"
    ("tenant_id", "provider_account_id", "operation_id", "provider_idempotency_key")
  WHERE "version" = 2;
--> statement-breakpoint

-- Composite FKs enforce scope. All referenced composite keys exist:
--   intents(tenant_id,id)                          PR2 intents_tenant_id_id_uniq
--   provider_operations(tenant_id,workspace_id,provider_account_id,id)  PR1
--   secret_routes(tenant_id,id)                    PR1 secret_routes_tenant_id_unique_idx
--   secrets(tenant_id,id)                          PR1 secrets_tenant_id_unique_idx
ALTER TABLE "execution_authorization_nonces"
  ADD CONSTRAINT "exec_auth_nonces_intent_fk"
    FOREIGN KEY ("tenant_id", "intent_id") REFERENCES "intents" ("tenant_id", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "exec_auth_nonces_operation_fk"
    FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id", "operation_id")
    REFERENCES "provider_operations" ("tenant_id", "workspace_id", "provider_account_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exec_auth_nonces_route_fk"
    FOREIGN KEY ("tenant_id", "route_id") REFERENCES "secret_routes" ("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "exec_auth_nonces_secret_fk"
    FOREIGN KEY ("tenant_id", "secret_id") REFERENCES "secrets" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. secret_routes: governed cutover columns (authority_mode + operation)
-- ─────────────────────────────────────────────────────────────────────────────
-- authority_revision + the bump trigger already exist (0081, G1). Here we add
-- the mode/operation columns and extend the trigger predicate to bump on their
-- change too.
CREATE TYPE "secret_route_authority_mode" AS ENUM ('legacy','governed_v2');
--> statement-breakpoint

ALTER TABLE "secret_routes"
  ADD COLUMN "authority_mode" "secret_route_authority_mode" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "provider_operation_id" uuid;
--> statement-breakpoint

-- A governed route must name its operation; a legacy route must not.
ALTER TABLE "secret_routes"
  ADD CONSTRAINT "secret_routes_governed_operation_chk" CHECK (
    ("authority_mode" = 'legacy'  AND "provider_operation_id" IS NULL)
    OR
    ("authority_mode" = 'governed_v2' AND "provider_operation_id" IS NOT NULL)
  );
--> statement-breakpoint

-- Contradiction C1 (reported): spec §1.2 names the FK target
-- provider_operations(tenant_id, id), but PR1's 0079 created only the 4-col
-- unique (tenant_id, workspace_id, provider_account_id, id) and the single-col
-- PK. A composite FK needs a matching unique key on the target columns, so add
-- the 2-col unique here (mirrors PR2's intents_tenant_id_id_uniq added for the
-- identical reason). This preserves the spec's tenant-scoped composite FK.
CREATE UNIQUE INDEX "provider_operations_tenant_id_id_uniq"
  ON "provider_operations" ("tenant_id", "id");
--> statement-breakpoint

-- Composite FK ties the governed route to a PR1 operation in the same tenant.
ALTER TABLE "secret_routes"
  ADD CONSTRAINT "secret_routes_provider_operation_fk"
    FOREIGN KEY ("tenant_id", "provider_operation_id")
    REFERENCES "provider_operations" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint

-- Extend the 0081 bump trigger function: authority_mode / provider_operation_id
-- changes now ALSO bump authority_revision (PR4 §1.2), which stales any unconsumed
-- v2 authorization on a cutover/rollback (X5, §2.4). CREATE OR REPLACE keeps the
-- existing trigger binding; only the function body's predicate grows.
CREATE OR REPLACE FUNCTION steward_bump_secret_route_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (
    OLD."host_pattern"          IS DISTINCT FROM NEW."host_pattern"          OR
    OLD."path_pattern"          IS DISTINCT FROM NEW."path_pattern"          OR
    OLD."method"                IS DISTINCT FROM NEW."method"                OR
    OLD."inject_as"             IS DISTINCT FROM NEW."inject_as"             OR
    OLD."inject_key"            IS DISTINCT FROM NEW."inject_key"            OR
    OLD."inject_format"         IS DISTINCT FROM NEW."inject_format"         OR
    OLD."secret_id"             IS DISTINCT FROM NEW."secret_id"             OR
    OLD."enabled"               IS DISTINCT FROM NEW."enabled"               OR
    OLD."authority_mode"        IS DISTINCT FROM NEW."authority_mode"        OR
    OLD."provider_operation_id" IS DISTINCT FROM NEW."provider_operation_id"
  ) THEN
    NEW."authority_revision" := OLD."authority_revision" + 1;
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
-- Trigger `secret_routes_bump_authority_revision` already binds this function
-- (created in 0081). CREATE OR REPLACE above rebinds the new body automatically.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. provider_action_bindings: admit the PR4 execution lifecycle states
-- ─────────────────────────────────────────────────────────────────────────────
-- Spec §2.2: PR4 adds the terminal binding states PR3 reserved (executing,
-- succeeded, failed, outcome_unknown). PR3's state_chk / approval_shape_chk /
-- transition trigger only know the approval lifecycle up to execution_ready, so
-- they MUST be extended here or PR4's dispatch transitions fail closed at the DB.
-- (Deviation flagged in the PR body: PR4 extends PR3-owned constraints because
-- the states are PR4's, mirroring the G1 "each PR owns the columns/states its
-- invariants require" adjudication.)

-- 3a0. Widen the canonical-profile CHECK to admit the X adapter profile.
-- 0080 hardcoded the github literal (`canonical_profile = 'github.provider-action.v1'`),
-- which blocked X governed bindings from persisting (the five describe.skip E2Es in
-- provider-x-governed-e2e.test.ts, added by #198, were gated ONLY on this). #196-#198
-- shipped the X adapter + canonical profile (`x.provider-action.v1`) end to end; the
-- sole remaining gate was this allowlist. Widening it to an IN-list is a pure additive
-- relaxation (no existing github row can violate it) and is done here — alongside the
-- other provider_action_bindings CHECK extensions this migration already performs —
-- rather than deferring a trivial 2-statement change to 0083. New adapters extend this
-- list; the pipeline is otherwise adapter-agnostic.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_profile_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_profile_chk"
  CHECK ("canonical_profile" IN ('github.provider-action.v1', 'x.provider-action.v1'));
--> statement-breakpoint

-- 3a0b. Extend the status allowlist CHECK to admit the PR4 execution states.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_status_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_status_chk"
  CHECK ("status" IN (
    'denied','pending_approval','allowed_stub','stub_succeeded','stub_failed',
    'approved','execution_ready','approval_denied','approval_expired','approval_stale',
    'executing','succeeded','failed','outcome_unknown'
  ));
--> statement-breakpoint

-- 3a. Extend the state_chk approval arm to include the PR4 execution states.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_state_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_state_chk" CHECK (
  ("access_effect" = 'deny' AND "policy_effect" = 'not_evaluated' AND "status" = 'denied') OR
  ("access_effect" = 'allow' AND "policy_effect" = 'hard_deny' AND "status" = 'denied') OR
  ("access_effect" = 'allow' AND "policy_effect" = 'approval_required'
    AND "status" IN ('pending_approval','approved','execution_ready',
                     'approval_denied','approval_expired','approval_stale',
                     'executing','succeeded','failed','outcome_unknown')) OR
  ("access_effect" = 'allow' AND "policy_effect" = 'allow'
    AND "status" IN ('allowed_stub','stub_succeeded','stub_failed'))
);
--> statement-breakpoint

-- 3b. Extend the per-state field-shape CHECK for the PR4 execution states. Each
-- keeps the execution_ready evidence columns (approval actor/approved_at/resume*)
-- since PR4 does not clear them; they carry through the terminal lifecycle.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_approval_shape_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_approval_shape_chk" CHECK (
  ("status" NOT IN ('pending_approval','approved','execution_ready','approval_denied','approval_expired','approval_stale','executing','succeeded','failed','outcome_unknown')
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
  -- execution_ready + all PR4 execution states share the same required evidence
  -- shape (the resume evidence is set once at execution_ready and carried).
  ("status" IN ('execution_ready','executing','succeeded','failed','outcome_unknown')
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

-- 3c. Extend the transition trigger's allowlist with the PR4 execution graph:
--   execution_ready -> executing
--   executing       -> succeeded | failed | outcome_unknown
--   outcome_unknown -> succeeded | failed        (reconciliation, never blind)
-- PR4 execution transitions increment binding_revision by exactly 1 (same
-- optimistic-lock convention as PR3). The frozen-column guard + revision rules
-- are unchanged; only the allowed OLD->NEW pairs grow.
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
  frozen_old := to_jsonb(OLD);
  frozen_new := to_jsonb(NEW);
  FOREACH col IN ARRAY mutable LOOP
    frozen_old := frozen_old - col;
    frozen_new := frozen_new - col;
  END LOOP;
  IF frozen_old IS DISTINCT FROM frozen_new THEN
    RAISE EXCEPTION 'provider_action_bindings frozen column mutated' USING ERRCODE = '23514';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF (OLD.status = 'allowed_stub' AND NEW.status IN ('stub_succeeded','stub_failed')) THEN
      IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision THEN
        RAISE EXCEPTION 'provider_action_bindings stub transition must not change binding_revision'
          USING ERRCODE = '23514';
      END IF;
    ELSIF (
      -- PR3 approval lifecycle.
      (OLD.status = 'pending_approval' AND NEW.status IN ('approved','approval_denied','approval_expired','approval_stale')) OR
      (OLD.status = 'approved'         AND NEW.status IN ('execution_ready','approval_expired','approval_stale')) OR
      -- PR4 execution lifecycle.
      (OLD.status = 'execution_ready'  AND NEW.status = 'executing') OR
      (OLD.status = 'execution_ready'  AND NEW.status = 'failed') OR
      (OLD.status = 'executing'        AND NEW.status IN ('succeeded','failed','outcome_unknown')) OR
      (OLD.status = 'outcome_unknown'  AND NEW.status IN ('succeeded','failed'))
    ) THEN
      IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision + 1 THEN
        RAISE EXCEPTION 'provider_action_bindings binding_revision must increment by exactly one on transition'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'illegal provider_action_bindings status transition'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision THEN
      RAISE EXCEPTION 'provider_action_bindings binding_revision changed without a status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
-- Trigger `provider_action_bindings_immutable` already binds this function
-- (created in 0081). CREATE OR REPLACE above rebinds the new body automatically.
