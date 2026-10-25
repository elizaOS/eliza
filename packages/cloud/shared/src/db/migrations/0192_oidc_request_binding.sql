ALTER TABLE "oidc_authorization_requests" ADD COLUMN IF NOT EXISTS "binding_hash" text;
--> statement-breakpoint
DELETE FROM "oidc_authorization_requests" WHERE "binding_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "oidc_authorization_requests" ALTER COLUMN "binding_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "oidc_authorization_codes" DROP COLUMN IF EXISTS "auth_time";
