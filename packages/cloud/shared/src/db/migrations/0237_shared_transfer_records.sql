-- Destination-bound transfer records for Shared→Dedicated promotion (round 4).
-- One row per promotion attempt: bound destination host + replay receipts.
CREATE TABLE IF NOT EXISTS "shared_transfer_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"destination_host" text NOT NULL,
	"seal_digest" text,
	"batch_count" integer,
	"state" text NOT NULL,
	"receipts" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
ALTER TABLE "shared_transfer_records" ADD CONSTRAINT "shared_transfer_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "shared_transfer_records" ADD CONSTRAINT "shared_transfer_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shared_transfer_records_scope_epoch" ON "shared_transfer_records" ("organization_id","user_id","agent_id","epoch");
CREATE INDEX IF NOT EXISTS "idx_shared_transfer_records_scope_state" ON "shared_transfer_records" ("organization_id","user_id","agent_id","state");
