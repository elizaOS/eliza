CREATE TABLE IF NOT EXISTS "remote_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"device_id" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"connection_mode" text NOT NULL,
	"runtime_key_id" text NOT NULL,
	"signing_public_jwk" jsonb NOT NULL,
	"encryption_public_jwk" jsonb NOT NULL,
	"host_token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "remote_hosts_status_check" CHECK (
		("status" = 'active' AND "revoked_at" IS NULL)
		OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_hosts_owner_idx"
	ON "remote_hosts" ("organization_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remote_hosts_owner_device_unique"
	ON "remote_hosts" ("organization_id", "user_id", "device_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remote_hosts_owner_runtime_key_unique"
	ON "remote_hosts" ("organization_id", "user_id", "runtime_key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_hosts_status_idx" ON "remote_hosts" ("status");
--> statement-breakpoint
ALTER TABLE "remote_sessions" ALTER COLUMN "agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "host_id" uuid
	REFERENCES "remote_hosts"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "grant_id" uuid;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "grant_revision" integer;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "controller_device_id" text;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "controller_key_id" text;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "controller_display_name" text;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "controller_platform" text;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "controller_signing_public_jwk" jsonb;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "controller_encryption_public_jwk" jsonb;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "target_key_id" text;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "last_sequence" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "pairing_consumed_at" timestamptz;
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "grant_expires_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_exactly_one_target_check"
	CHECK (("agent_id" IS NOT NULL) <> ("host_id" IS NOT NULL));
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_host_authority_shape_check"
	CHECK ("host_id" IS NULL OR (
		"grant_id" IS NOT NULL AND "grant_revision" > 0 AND "controller_device_id" IS NOT NULL
		AND "controller_key_id" IS NOT NULL AND "controller_signing_public_jwk" IS NOT NULL
		AND "controller_encryption_public_jwk" IS NOT NULL AND "target_key_id" IS NOT NULL
		AND "grant_expires_at" IS NOT NULL
	));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_sessions_host_id_idx" ON "remote_sessions" ("host_id");
CREATE INDEX IF NOT EXISTS "remote_sessions_host_status_idx"
	ON "remote_sessions" ("host_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "remote_sessions_grant_id_unique"
	ON "remote_sessions" ("grant_id");
