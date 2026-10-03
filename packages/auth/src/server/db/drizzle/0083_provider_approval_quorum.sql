-- #205: M-of-N quorum approval for provider actions (competitive parity vs
-- Turnkey REQUIRES_CONSENSUS / Fireblocks / Privy).
--
-- Generalizes the single-approver provider-action approval (0081) to flat N-of-M
-- quorum WITHOUT changing the absent-quorum path. Nested quorums are OUT OF SCOPE
-- (flat N-of-M only). This migration:
--
--   1. Adds nullable quorum config + a guarded running tally to `approval_queue`.
--      A NULL `quorum_threshold` is the single-approver legacy path (byte-for-byte
--      unchanged: no new NOT NULL column without a default, no trigger change on
--      the legacy arm).
--   2. Creates `provider_action_approvals`: one row per DISTINCT approver decision
--      in a quorum, each binding the exact request_hash / action_digest /
--      approval_commitment_hash and the binding_revision it was cast against.
--   3. Adds a fail-closed CHECK on the quorum config shape so a malformed
--      threshold cannot be stored (defense in depth; the service also validates).
--
-- `intents` remains the sole lifecycle root. There is no second execution ledger:
-- the quorum tally lives on the existing approval_queue row and the collected
-- decisions in provider_action_approvals; the tamper-evident audit chain carries
-- quorum progress through the existing provider.approval.decided events.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. approval_queue quorum config + tally
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "approval_queue"
  ADD COLUMN "quorum_threshold" integer;
--> statement-breakpoint
ALTER TABLE "approval_queue"
  ADD COLUMN "quorum_eligible_user_ids" uuid[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "approval_queue"
  ADD COLUMN "quorum_approvals_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Fail-closed config shape. A NULL threshold (single-approver path) must keep an
-- empty eligible set and a zero tally. A non-NULL threshold must be a positive
-- integer no larger than the eligible set size, and the tally can never exceed
-- the threshold or go negative. Storing a malformed quorum is impossible.
ALTER TABLE "approval_queue"
  ADD CONSTRAINT "approval_queue_quorum_shape_chk" CHECK (
    (
      "quorum_threshold" IS NULL
      AND coalesce(array_length("quorum_eligible_user_ids", 1), 0) = 0
      AND "quorum_approvals_count" = 0
    )
    OR (
      "quorum_threshold" IS NOT NULL
      AND "quorum_threshold" >= 1
      AND "quorum_threshold" <= coalesce(array_length("quorum_eligible_user_ids", 1), 0)
      AND "quorum_approvals_count" >= 0
      AND "quorum_approvals_count" <= "quorum_threshold"
    )
  );
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. provider_action_approvals: one row per DISTINCT approver decision
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "provider_action_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "approval_queue_id" varchar(64) NOT NULL,
  "intent_id" varchar(64) NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "approver_user_id" uuid NOT NULL,
  "decision" varchar(16) NOT NULL,
  "binding_revision_at_decision" integer NOT NULL,
  "request_hash" varchar(71) NOT NULL,
  "action_digest" varchar(71) NOT NULL,
  "approval_commitment_hash" varchar(71) NOT NULL,
  "decision_idempotency_key_hash" varchar(71) NOT NULL,
  "decision_request_hash" varchar(71) NOT NULL,
  "mfa_verified_at" timestamp with time zone,
  "mfa_age_ms_at_decision" integer,
  "reason_code" varchar(96),
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_action_approvals_decision_chk"
    CHECK ("decision" IN ('approve', 'deny')),
  CONSTRAINT "provider_action_approvals_binding_rev_chk"
    CHECK ("binding_revision_at_decision" >= 1)
);
--> statement-breakpoint

ALTER TABLE "provider_action_approvals"
  ADD CONSTRAINT "provider_action_approvals_queue_fk"
  FOREIGN KEY ("approval_queue_id") REFERENCES "approval_queue"("id") ON DELETE cascade;
--> statement-breakpoint

-- Distinctness: an approver counts at most once per approval; a second decision
-- by the same user is rejected loudly (unique violation surfaced as a 409).
CREATE UNIQUE INDEX "provider_action_approvals_approver_uniq"
  ON "provider_action_approvals" ("approval_queue_id", "approver_user_id");
--> statement-breakpoint

-- Cross-action decision-idempotency-key reuse guard (mirrors approval_queue).
CREATE UNIQUE INDEX "provider_action_approvals_idem_uniq"
  ON "provider_action_approvals" ("tenant_id", "approver_user_id", "decision_idempotency_key_hash");
--> statement-breakpoint

CREATE INDEX "provider_action_approvals_queue_idx"
  ON "provider_action_approvals" ("approval_queue_id");
--> statement-breakpoint

CREATE INDEX "provider_action_approvals_intent_idx"
  ON "provider_action_approvals" ("tenant_id", "intent_id");
