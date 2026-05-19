ALTER TABLE "connector_accounts" ADD COLUMN IF NOT EXISTS "owner_binding_id" text;
--> statement-breakpoint
ALTER TABLE "connector_accounts" ADD COLUMN IF NOT EXISTS "owner_identity_id" text;
--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD COLUMN IF NOT EXISTS "code_verifier_ref" text;
