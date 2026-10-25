-- DB-backed pending-charge + settlement ledger for Tier-2 optimistic inference
-- billing (#9899). The durable, exactly-once replacement for the KV pending-charge
-- backstop — it closes the at-scale residuals KV cannot:
--   * hard concurrent-overdraw bound  (atomic admission under an org row lock),
--   * exactly-once settlement          (request_id PK + `WHERE status='pending'` claim),
--   * age-ordered sweep drain          (partial index on enqueued_at).
--
-- See packages/cloud/api/docs/inference-hot-path.md and
-- packages/cloud/shared/src/lib/services/inference-billing-ledger.ts.
--
-- Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, guarded FKs, no
-- backfill, no drops. Selected at runtime by INFERENCE_BILLING_LEDGER="db"
-- (default "kv") so creating the table changes no behavior until the flag flips.

CREATE TABLE IF NOT EXISTS "inference_pending_charges" (
	"request_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"billing_source" text NOT NULL,
	"estimated_cost_usd" numeric(12, 6) NOT NULL,
	"actual_cost_usd" numeric(12, 6),
	"status" text DEFAULT 'pending' NOT NULL,
	"enqueued_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inference_pending_charges" ADD CONSTRAINT "inference_pending_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inference_pending_charges" ADD CONSTRAINT "inference_pending_charges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inference_pending_charges_pending_age_idx" ON "inference_pending_charges" USING btree ("enqueued_at") WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inference_pending_charges_org_pending_idx" ON "inference_pending_charges" USING btree ("organization_id") WHERE status = 'pending';
