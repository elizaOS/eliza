-- #11332: team credential pool (Phase 1 — org API-key pool).
--
-- `pooled_credentials` holds ONLY pool metadata (columns mirror
-- LinkedAccountConfig/HealthDetail/Usage from @elizaos/contracts); the key
-- material itself is a `secrets` row (AES-256-GCM envelope) referenced by
-- secret_id. `pooled_credential_usage` is the per-member daily rollup
-- (org, credential, user, day, calls) for usage attribution.
--
-- Prod-safe: additive only (two new tables + indexes), IF NOT EXISTS
-- throughout, no CONCURRENTLY, no touches to existing tables.
CREATE TABLE IF NOT EXISTS "pooled_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_last4" text NOT NULL,
	"contributed_by" uuid,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" text DEFAULT 'ok' NOT NULL,
	"health_detail" jsonb,
	"usage" jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pooled_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade,
	CONSTRAINT "pooled_credentials_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE cascade,
	CONSTRAINT "pooled_credentials_contributed_by_users_id_fk" FOREIGN KEY ("contributed_by") REFERENCES "users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pooled_credential_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pooled_credential_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade,
	CONSTRAINT "pooled_credential_usage_credential_id_pooled_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "pooled_credentials"("id") ON DELETE cascade,
	CONSTRAINT "pooled_credential_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pooled_credentials_org_idx" ON "pooled_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pooled_credentials_org_provider_idx" ON "pooled_credentials" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pooled_credentials_contributed_by_idx" ON "pooled_credentials" USING btree ("contributed_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pooled_credentials_secret_id_idx" ON "pooled_credentials" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pooled_credential_usage_org_idx" ON "pooled_credential_usage" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pooled_credential_usage_credential_idx" ON "pooled_credential_usage" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pooled_credential_usage_cred_user_day_idx" ON "pooled_credential_usage" USING btree ("credential_id","user_id","day");
