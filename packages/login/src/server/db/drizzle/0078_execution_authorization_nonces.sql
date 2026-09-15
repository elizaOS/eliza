CREATE TYPE "public"."execution_authorization_status" AS ENUM('active', 'consumed', 'expired', 'revoked');
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "execution_payload_digest" varchar(64);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "execution_policy_revision_hash" varchar(64);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_authorization_nonces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "authorization_id" varchar(64) NOT NULL,
  "request_id" varchar(64) NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "capability" varchar(64) NOT NULL,
  "backend" varchar(64) NOT NULL,
  "payload_digest" varchar(64) NOT NULL,
  "policy_revision_hash" varchar(64),
  "approval_id" varchar(64),
  "nonce" varchar(64) NOT NULL,
  "signature" text NOT NULL,
  "idempotency_key" text,
  "status" "execution_authorization_status" DEFAULT 'active' NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_authorization_nonces" ADD CONSTRAINT "execution_authorization_nonces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_authorization_nonces" ADD CONSTRAINT "execution_authorization_nonces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_authorization_nonces_auth_id_idx" ON "execution_authorization_nonces" USING btree ("authorization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_authorization_nonces_nonce_idx" ON "execution_authorization_nonces" USING btree ("nonce");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_authorization_nonces_tenant_agent_status_idx" ON "execution_authorization_nonces" USING btree ("tenant_id","agent_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_authorization_nonces_expires_at_idx" ON "execution_authorization_nonces" USING btree ("expires_at");
--> statement-breakpoint
-- Deployment-safe invalidation of legacy pending primary-EVM approvals.
--
-- After this migration the approval-replay path fails closed for any primary
-- EVM approval that lacks a stored execution_payload_digest OR a stored
-- execution_policy_revision_hash (see packages/api/src/routes/vault.ts approve
-- handler). Those legacy rows can no longer be replayed and MUST be resubmitted
-- by the caller. We deterministically mark them denied here so they do not sit
-- as un-actionable "pending" approvals.
--
-- Scope is intentionally narrow and matches the runtime fail-closed criteria
-- EXACTLY, so we never touch a row that would still be replayable:
--   * transactions.status = 'pending'
--   * a matching pending approval_queue row exists
--   * EVM chain family only (chain_id NOT IN (101,102) Solana)
--   * primary transaction action surface only: action_type IS NULL or
--     'transaction'. Transfer / send_calls / user_operation / authorization
--     surfaces are excluded (transfer has its own replay; the AA surfaces are
--     already hard-disabled in the approve handler).
--   * newly-added binding columns are absent (digest or policy-revision NULL).
-- Rows minted WITH both bindings are left untouched; they remain replayable.
UPDATE "approval_queue" AS aq
SET "status" = 'rejected',
    "resolved_at" = now(),
    "resolved_by" = 'system:migration-0078-execution-authorization',
    "resolved_by_type" = 'system',
    "resolved_by_id" = 'migration-0078'
FROM "transactions" AS t
WHERE aq."tx_id" = t."id"
  AND aq."agent_id" = t."agent_id"
  AND aq."status" = 'pending'
  AND t."status" = 'pending'
  AND t."chain_id" NOT IN (101, 102)
  AND (t."action_type" IS NULL OR t."action_type" = 'transaction')
  AND (
    t."execution_payload_digest" IS NULL
    OR t."execution_policy_revision_hash" IS NULL
  );
--> statement-breakpoint
UPDATE "transactions" AS t
SET "status" = 'rejected'
WHERE t."status" = 'pending'
  AND t."chain_id" NOT IN (101, 102)
  AND (t."action_type" IS NULL OR t."action_type" = 'transaction')
  AND (
    t."execution_payload_digest" IS NULL
    OR t."execution_policy_revision_hash" IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM "approval_queue" AS aq
    WHERE aq."tx_id" = t."id"
      AND aq."agent_id" = t."agent_id"
      AND aq."resolved_by" = 'system:migration-0078-execution-authorization'
  );
