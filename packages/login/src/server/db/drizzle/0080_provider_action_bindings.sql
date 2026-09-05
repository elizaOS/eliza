-- PR2: provider_action_bindings — the 1:1 typed companion to intents that
-- carries the canonical provider-action, the request envelope, and the two
-- separate (access + policy) decision documents with distinct IDs/hashes.
-- intents remains the sole lifecycle root (adjudication Conflict 16, ratified).

-- Composite unique required by the strict composite FK from the binding.
ALTER TABLE "intents"
  ADD CONSTRAINT "intents_tenant_id_id_uniq" UNIQUE ("tenant_id", "id");
--> statement-breakpoint

CREATE TABLE "provider_action_bindings" (
  "intent_id" varchar(64) PRIMARY KEY,
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "actor_agent_id" varchar(64) NOT NULL,
  "provider_account_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "operation_revision" integer NOT NULL,

  "canonical_profile" varchar(96) NOT NULL,
  "canonical_action_bytes" bytea NOT NULL,
  "action_digest" varchar(71) NOT NULL,
  "request_envelope" jsonb NOT NULL,
  "request_hash" varchar(71) NOT NULL,
  "idempotency_key_hash" varchar(71) NOT NULL,
  "safe_summary" jsonb NOT NULL,

  "access_decision_id" uuid NOT NULL,
  "access_effect" varchar(16) NOT NULL,
  "access_reason_code" varchar(96) NOT NULL,
  "matched_binding_ids" uuid[] NOT NULL DEFAULT '{}',
  "matched_grant_ids" uuid[] NOT NULL DEFAULT '{}',
  "dependency_revisions" jsonb NOT NULL,
  "access_decision" jsonb NOT NULL,
  "access_decision_hash" varchar(71) NOT NULL,

  "policy_decision_id" uuid,
  "policy_effect" varchar(24) NOT NULL,
  "policy_reason_codes" text[] NOT NULL DEFAULT '{}',
  "policy_results" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "policy_revision_hash" varchar(71),
  "policy_decision" jsonb,
  "policy_decision_hash" varchar(71),

  "status" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "provider_action_bindings_intent_fk"
    FOREIGN KEY ("tenant_id", "intent_id")
    REFERENCES "intents" ("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_action_bindings_actor_fk"
    FOREIGN KEY ("tenant_id", "actor_agent_id")
    REFERENCES "agents" ("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_action_bindings_workspace_fk"
    FOREIGN KEY ("tenant_id", "workspace_id")
    REFERENCES "workspaces" ("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_action_bindings_account_fk"
    FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id")
    REFERENCES "provider_accounts" ("tenant_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_action_bindings_operation_fk"
    FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id", "operation_id")
    REFERENCES "provider_operations"
      ("tenant_id", "workspace_id", "provider_account_id", "id") ON DELETE RESTRICT,

  CONSTRAINT "provider_action_bindings_operation_revision_chk"
    CHECK ("operation_revision" > 0),
  CONSTRAINT "provider_action_bindings_profile_chk"
    CHECK ("canonical_profile" = 'github.provider-action.v1'),
  CONSTRAINT "provider_action_bindings_action_digest_chk"
    CHECK ("action_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "provider_action_bindings_request_hash_chk"
    CHECK ("request_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "provider_action_bindings_idem_hash_chk"
    CHECK ("idempotency_key_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "provider_action_bindings_access_hash_chk"
    CHECK ("access_decision_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "provider_action_bindings_access_effect_chk"
    CHECK ("access_effect" IN ('allow','deny')),
  CONSTRAINT "provider_action_bindings_policy_effect_chk"
    CHECK ("policy_effect" IN ('not_evaluated','hard_deny','approval_required','allow')),
  CONSTRAINT "provider_action_bindings_policy_shape_chk" CHECK (
    ("policy_effect" = 'not_evaluated'
      AND "policy_decision_id" IS NULL AND "policy_revision_hash" IS NULL
      AND "policy_decision" IS NULL AND "policy_decision_hash" IS NULL)
    OR
    ("policy_effect" <> 'not_evaluated'
      AND "policy_decision_id" IS NOT NULL
      AND "policy_revision_hash" ~ '^sha256:[0-9a-f]{64}$'
      AND "policy_decision" IS NOT NULL
      AND "policy_decision_hash" ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT "provider_action_bindings_status_chk"
    CHECK ("status" IN ('denied','pending_approval','allowed_stub','stub_succeeded','stub_failed')),
  CONSTRAINT "provider_action_bindings_state_chk" CHECK (
    ("access_effect" = 'deny' AND "policy_effect" = 'not_evaluated' AND "status" = 'denied') OR
    ("access_effect" = 'allow' AND "policy_effect" = 'hard_deny' AND "status" = 'denied') OR
    ("access_effect" = 'allow' AND "policy_effect" = 'approval_required' AND "status" = 'pending_approval') OR
    ("access_effect" = 'allow' AND "policy_effect" = 'allow'
      AND "status" IN ('allowed_stub','stub_succeeded','stub_failed'))
  ),
  CONSTRAINT "provider_action_bindings_canonical_bytes_size_chk"
    CHECK (octet_length("canonical_action_bytes") BETWEEN 2 AND 1048576),
  CONSTRAINT "provider_action_bindings_safe_summary_size_chk"
    CHECK (octet_length("safe_summary"::text) <= 16384)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "provider_action_bindings_access_decision_id_uniq"
  ON "provider_action_bindings" ("access_decision_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_action_bindings_policy_decision_id_uniq"
  ON "provider_action_bindings" ("policy_decision_id") WHERE "policy_decision_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_action_bindings_request_hash_uniq"
  ON "provider_action_bindings" ("request_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_action_bindings_idempotency_uniq"
  ON "provider_action_bindings"
    ("tenant_id", "workspace_id", "actor_agent_id", "operation_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE INDEX "provider_action_bindings_scope_created_idx"
  ON "provider_action_bindings" ("tenant_id", "workspace_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "provider_action_bindings_account_operation_created_idx"
  ON "provider_action_bindings"
    ("tenant_id", "workspace_id", "provider_account_id", "operation_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "provider_action_bindings_actor_status_created_idx"
  ON "provider_action_bindings" ("tenant_id", "actor_agent_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "provider_action_bindings_pending_idx"
  ON "provider_action_bindings" ("tenant_id", "workspace_id", "created_at")
  WHERE "status" = 'pending_approval';
--> statement-breakpoint

-- Immutability trigger: only `status` and `updated_at` may change post-insert.
-- In PR2 the sole legal status transition is
--   allowed_stub -> stub_succeeded | stub_failed
-- every other status is terminal. PR3 replaces this narrow rule with its
-- approval lifecycle. Direct deletion is not exposed.
CREATE OR REPLACE FUNCTION steward_provider_action_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  frozen_old jsonb;
  frozen_new jsonb;
BEGIN
  -- Every column except status/updated_at is immutable. Compare a projection of
  -- the row with status/updated_at stripped; any difference is a frozen-column
  -- mutation.
  frozen_old := (to_jsonb(OLD) - 'status') - 'updated_at';
  frozen_new := (to_jsonb(NEW) - 'status') - 'updated_at';
  IF frozen_old IS DISTINCT FROM frozen_new THEN
    RAISE EXCEPTION 'provider_action_bindings frozen column mutated' USING ERRCODE = '23514';
  END IF;
  -- Status transition allowlist (PR2): only allowed_stub -> stub_succeeded|stub_failed.
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT (OLD.status = 'allowed_stub' AND NEW.status IN ('stub_succeeded','stub_failed')) THEN
      RAISE EXCEPTION 'illegal provider_action_bindings status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER provider_action_bindings_immutable
  BEFORE UPDATE ON "provider_action_bindings"
  FOR EACH ROW EXECUTE FUNCTION steward_provider_action_binding_guard();
--> statement-breakpoint

-- Transactional required-audit outbox (spec §6.4). Because the tenant audit
-- chain is written by its own advisory-locked transaction (writeAuditEvent), a
-- provider-action decision commits its REQUIRED audit intent DURABLY in the SAME
-- transaction as the binding by inserting an outbox row here. The row is drained
-- into the tamper-evident audit chain immediately after commit and BEFORE the
-- executor stub can run. If the drain fails the request denies
-- (EVIDENCE_REQUIRED_AUDIT_UNAVAILABLE, 503) with the stub call count zero; the
-- durable outbox row guarantees the event is never lost.
CREATE TABLE "provider_action_audit_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL,
  "intent_id" varchar(64) NOT NULL,
  "action" varchar(96) NOT NULL,
  "resource_type" varchar(64) NOT NULL,
  "resource_id" varchar(255) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "provider_action_audit_outbox_intent_fk"
    FOREIGN KEY ("tenant_id", "intent_id")
    REFERENCES "intents" ("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "provider_action_audit_outbox_undelivered_idx"
  ON "provider_action_audit_outbox" ("tenant_id", "created_at")
  WHERE "delivered_at" IS NULL;
