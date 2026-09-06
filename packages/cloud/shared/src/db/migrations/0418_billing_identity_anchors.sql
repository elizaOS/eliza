-- Retained financial identities do not grant live account authority.
CREATE TABLE IF NOT EXISTS "billing_eligibility_principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_identity_subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"live_user_id" uuid,
	"eligibility_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_identity_subjects_actor_identity_check" CHECK ("billing_identity_subjects"."live_user_id" IS NULL OR "billing_identity_subjects"."live_user_id" = "billing_identity_subjects"."id")
);
--> statement-breakpoint
ALTER TABLE "billing_identity_subjects" ADD CONSTRAINT "billing_identity_subjects_live_user_id_users_id_fk" FOREIGN KEY ("live_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_identity_subjects" ADD CONSTRAINT "billing_identity_subjects_eligibility_principal_id_billing_eligibility_principals_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "public"."billing_eligibility_principals"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_identity_subjects_live_user_idx" ON "billing_identity_subjects" USING btree ("live_user_id");
