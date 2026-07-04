-- PR / press distribution domain model (#11818).

CREATE TABLE IF NOT EXISTS "press_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"boilerplate" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"target_audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embargo_at" timestamp,
	"submitted_at" timestamp,
	"distributed_at" timestamp,
	"failed_reason" text,
	"idempotency_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "press_releases_org_idx" ON "press_releases" ("organization_id");
CREATE INDEX IF NOT EXISTS "press_releases_status_idx" ON "press_releases" ("status");
CREATE INDEX IF NOT EXISTS "press_releases_created_idx" ON "press_releases" ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "press_releases_idempotency_key_uidx" ON "press_releases" ("idempotency_key");

CREATE TABLE IF NOT EXISTS "press_release_distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"press_release_id" uuid NOT NULL REFERENCES "press_releases"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"external_distribution_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"submitted_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "press_release_distributions_org_idx" ON "press_release_distributions" ("organization_id");
CREATE INDEX IF NOT EXISTS "press_release_distributions_release_idx" ON "press_release_distributions" ("press_release_id");
CREATE INDEX IF NOT EXISTS "press_release_distributions_provider_idx" ON "press_release_distributions" ("provider");
CREATE UNIQUE INDEX IF NOT EXISTS "press_release_distributions_idempotency_key_uidx" ON "press_release_distributions" ("idempotency_key");

CREATE TABLE IF NOT EXISTS "press_media_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"name" text NOT NULL,
	"outlet" text NOT NULL,
	"email" text,
	"beat" text,
	"region" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "press_media_contacts_org_idx" ON "press_media_contacts" ("organization_id");
CREATE INDEX IF NOT EXISTS "press_media_contacts_status_idx" ON "press_media_contacts" ("status");

CREATE TABLE IF NOT EXISTS "press_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"press_release_id" uuid NOT NULL REFERENCES "press_releases"("id") ON DELETE CASCADE,
	"distribution_id" uuid REFERENCES "press_release_distributions"("id") ON DELETE SET NULL,
	"url" text NOT NULL,
	"title" text,
	"outlet" text,
	"published_at" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "press_coverage_org_idx" ON "press_coverage" ("organization_id");
CREATE INDEX IF NOT EXISTS "press_coverage_release_idx" ON "press_coverage" ("press_release_id");
CREATE UNIQUE INDEX IF NOT EXISTS "press_coverage_release_url_uidx" ON "press_coverage" ("press_release_id", "url");
