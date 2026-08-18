-- Promotion epochs for Shared→Dedicated memory transfer (round 3).
-- Write fence + atomic-promotion state machine per transfer scope.
CREATE TABLE IF NOT EXISTS "shared_transfer_epochs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"state" text NOT NULL,
	"seal_digest" text,
	"fenced_at" timestamp,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
ALTER TABLE "shared_transfer_epochs" ADD CONSTRAINT "shared_transfer_epochs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "shared_transfer_epochs" ADD CONSTRAINT "shared_transfer_epochs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shared_transfer_epochs_scope_epoch" ON "shared_transfer_epochs" ("organization_id","user_id","agent_id","epoch");
CREATE INDEX IF NOT EXISTS "idx_shared_transfer_epochs_scope_state" ON "shared_transfer_epochs" ("organization_id","user_id","agent_id","state");
-- Only one non-terminal epoch per scope: the fence check and promotion flip
-- race-safely on this partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_shared_transfer_epochs_scope_active" ON "shared_transfer_epochs" ("organization_id","user_id","agent_id") WHERE "state" IN ('open','fenced');
