-- Managed frontend hosting (#10690): first-class per-app static-site deployments.
--
-- Each row is an immutable, content-addressed frontend deployment whose
-- artifacts live in R2 under r2_prefix. The partial unique index enforces at
-- most one ACTIVE deployment per app, which makes activation an atomic swap
-- (and gives free rollback — activate an older deployment). See
-- packages/cloud/shared/src/lib/services/app-frontend-hosting.ts.
--
-- Additive: CREATE ... IF NOT EXISTS, inline FKs, no backfill, no drops.

CREATE TABLE IF NOT EXISTS "app_frontend_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
	"version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"r2_prefix" text NOT NULL,
	"manifest" jsonb,
	"content_hash" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" integer DEFAULT 0 NOT NULL,
	"build_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"finalized_at" timestamp,
	"activated_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_frontend_deployments_app_id_idx" ON "app_frontend_deployments" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_frontend_deployments_app_version_idx" ON "app_frontend_deployments" USING btree ("app_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_frontend_deployments_active_idx" ON "app_frontend_deployments" USING btree ("app_id") WHERE status = 'active';
